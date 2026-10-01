/**
 * End-to-end story on a fresh local chain (run through ./scripts/e2e.sh, which starts the chain, postman and courier).
 *
 * Alice zips, sends privately to Bob's zip address, makes a zip link that Carol claims, pays a merchant with sales
 * tax, burns to speak and at Bob's door, earns a badge from a note, posts anonymously, asks a poll and answers it,
 * hands the courier a held job and checks its signed receipt, then fast-forwards a month and unlocks the badge. Every
 * balance is checked, and the gas each step really used is written to docs/GAS.md.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  badgeReturnSecrets,
  context,
  depositSecrets,
  encodeKnock,
  encodeLock,
  encodePayment,
  encodePollCreation,
  encodeRelay,
  encodeSend,
  encodeSpeech,
  entrypointAbi,
  groupMembers,
  hashPrecommitment,
  masterKeys,
  memberSiblings,
  mnemonicFromSignature,
  parseDeployment,
  parsePoolState,
  proveLeaf,
  proveMembership,
  proveSpend,
  randomSecrets,
  recoverNotes,
  recoverReceiptSigner,
  verifyReceipt,
  sealSecrets,
  badgeIdentity,
  toJson,
  withdrawalSecrets,
  zipAddressKeys,
  zipAddressRegistryAbi,
  zipBadgesAbi,
  zipMerchantsAbi,
  zipPayAbi,
  zipPollsAbi,
  zipSignalAbi,
  type MasterKeys,
  type Note,
  type NoteSecrets,
  type PoolState,
} from "../packages/sdk/src/index";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const RPC = env("RPC_URL");
const COURIER = env("COURIER_URL");
const POSTMAN = env("POSTMAN_URL");
const dep = parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const pub = createPublicClient({ transport: http(RPC) });
const dev = privateKeyToAccount(env("DEV_PRIVATE_KEY") as Hex);
const ZC = (n: number | string) => parseEther(String(n));
const fmt = (v: bigint) => formatEther(v);

const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------------------------------------------

const gas: { step: string; gas: bigint }[] = [];
let checks = 0;
const t0 = Date.now();

function check(ok: boolean, what: string) {
  checks++;
  if (!ok) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
}

async function recordTx(step: string, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${step}: transaction reverted (${hash})`);
  gas.push({ step, gas: r.gasUsed });
  return r;
}

const balance = async (a: Address) => (await pub.readContract({ address: dep.zc, abi: erc20, functionName: "balanceOf", args: [a] })) as bigint;

// ---------------------------------------------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------------------------------------------

const walletOf = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account, transport: http(RPC) });
type Person = { name: string; account: ReturnType<typeof privateKeyToAccount>; wallet: ReturnType<typeof walletOf>; keys: MasterKeys; zip: ReturnType<typeof zipAddressKeys> };

async function person(name: string, zc: number): Promise<Person> {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = walletOf(account);
  await pub.request({ method: "anvil_setBalance" as never, params: [account.address, "0xDE0B6B3A7640000"] as never });
  if (zc) {
    const devWallet = createWalletClient({ account: dev, transport: http(RPC) });
    await pub.waitForTransactionReceipt({ hash: await devWallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "transfer", args: [account.address, ZC(zc)] }) });
  }
  // A throwaway zip key per run, derived the way the wallet derives one from a signature
  const keys = masterKeys(mnemonicFromSignature(keccak256(generatePrivateKey())));
  return { name, account, wallet, keys, zip: zipAddressKeys(keys.masterSecret) };
}

// ---------------------------------------------------------------------------------------------------------------
// pool view (from the courier, verified like the wallet does)
// ---------------------------------------------------------------------------------------------------------------

async function pool() {
  const state = parsePoolState<PoolState>(await (await fetch(`${COURIER}/state`)).text());
  const labels = ((await (await fetch(`${COURIER}/asp`)).json()) as { labels: string[] }).labels.map(BigInt);
  return { state, labels };
}

const notesOf = async (p: Person, badgeLocks = 0) => {
  const { state, labels } = await pool();
  const r = recoverNotes(p.keys, dep.scope, state, { zipAddressKey: p.zip.privateKey, badgeLocks });
  return { ...r, spendable: r.notes.filter((n) => labels.includes(n.label)) };
};

/** Waits until the courier serves a view where `pred` holds (couriers refresh every 10 s, the postman every epoch). */
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutSec = 90): Promise<T> {
  const end = Date.now() + timeoutSec * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function spend(p: Person | null, note: Note, keys: MasterKeys | null, amount: bigint, kind: string, processooor: Address, data: Hex, holdSec = 0) {
  const { state, labels } = await pool();
  const next: NoteSecrets = keys ? withdrawalSecrets(keys, note.label, note.children) : randomSecrets();
  const proof = await proveSpend({
    value: note.value,
    label: note.label,
    nullifier: note.nullifier,
    secret: note.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor, data }, dep.scope),
    state: proveLeaf(state.leaves, note.commitment),
    asp: proveLeaf(labels, note.label),
  });
  return job(kind, { withdrawal: { processooor, data }, proof }, holdSec);
}

type Job = { id: string; tx?: Hex; status: string; deadline: number; receipt?: { message: Record<string, string>; signature: Hex; target: Address; callData: Hex } };

async function job(kind: string, body: Record<string, unknown>, holdSec = 0): Promise<Job> {
  const res = await fetch(`${COURIER}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ kind, holdSec, ...body }) });
  const j = (await res.json()) as Job & { error?: string };
  if (!res.ok) throw new Error(`courier refused ${kind}: ${j.error}`);
  return j;
}

async function delivered(step: string, j: Job) {
  const done = await until(`${step} delivery`, async () => {
    const s = (await (await fetch(`${COURIER}/jobs/${j.id}`)).json()) as Job;
    return s.status === "sent" ? s : s.status === "failed" ? Promise.reject(new Error(`${step} failed at the courier`)) : null;
  }, 120);
  await recordTx(step, done.tx!);
  return done;
}

const cleared = (p: Person, pred: (n: Note) => boolean, what: string, badgeLocks = 0) =>
  until(what, async () => (await notesOf(p, badgeLocks)).spendable.find(pred), 120);

// ---------------------------------------------------------------------------------------------------------------
// the story
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const courier = ((await (await fetch(`${COURIER}/quote`)).json()) as { courier: Address }).courier;
  const noFee = { feeRecipient: courier, fee: 0n };
  const alice = await person("Alice", 3000);
  const bob = await person("Bob", 0);
  const carol = await person("Carol", 0);
  const merchant = await person("Beautiful Plants", 1000);
  const treasury = dev.address;
  console.log(`e2e on ${RPC}; courier ${courier}`);

  console.log("\n1. Alice zips 1,500 ZC");
  const s0 = depositSecrets(alice.keys, dep.scope, 0n);
  await recordTx("zip: approve", await alice.wallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, ZC(1500)] }));
  await recordTx(
    "zip: deposit",
    await alice.wallet.writeContract({ chain: null, address: dep.entrypoint, abi: entrypointAbi, functionName: "deposit", args: [dep.zc, ZC(1500), hashPrecommitment(s0.nullifier, s0.secret)] }),
  );
  check((await balance(alice.account.address)) === ZC(1500), "Alice's wallet is down to 1,500 ZC");
  let note = await cleared(alice, (n) => n.value === ZC(1500), "Alice's deposit to clear");
  check(true, "the postman cleared the deposit at the next epoch");

  console.log("\n2. Bob sets up a zip address; Alice sends him 100 ZC inside the pool");
  await recordTx("zip address: setKey", await bob.wallet.writeContract({ chain: null, address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "setKey", args: [bob.zip.publicKey] }));
  const toBob = randomSecrets();
  const sendData = encodeSend({ precommitment: hashPrecommitment(toBob.nullifier, toBob.secret), ciphertext: sealSecrets(bob.zip.publicKey, toBob), courier: noFee });
  await delivered("send: rezip to a zip address", await spend(alice, note, alice.keys, ZC(100), "rezip", dep.rezip, sendData));
  const bobNote = await cleared(bob, (n) => n.origin === "received" && n.value === ZC(100), "Bob to find the note");
  check(bobNote.value === ZC(100), "Bob recovered a 100 ZC note by decrypting it; no wallet was involved");

  console.log("\n3. Alice makes a 50 ZC zip link; Carol claims it to her wallet");
  note = await cleared(alice, (n) => n.value === ZC(1400), "Alice's change note");
  const link = randomSecrets();
  const linkData = encodeSend({ precommitment: hashPrecommitment(link.nullifier, link.secret), ciphertext: "0x", courier: noFee });
  await delivered("send: zip link", await spend(alice, note, alice.keys, ZC(50), "rezip", dep.rezip, linkData));
  const linkNote = await until("the link note to clear", async () => {
    const { state, labels } = await pool();
    const d = state.deposits.find((x) => x.precommitment === hashPrecommitment(link.nullifier, link.secret));
    return d && labels.includes(d.label) ? ({ label: d.label, value: d.value, nullifier: link.nullifier, secret: link.secret, commitment: d.commitment, children: 0n, origin: "link" } as Note) : null;
  });
  await delivered("unzip: relay to an address", await spend(null, linkNote, null, ZC(50), "relay", dep.entrypoint, encodeRelay(carol.account.address, courier, 0n)));
  check((await balance(carol.account.address)) === ZC(50), "Carol's fresh wallet holds the 50 ZC, unlinked to Alice");

  console.log("\n4. A merchant lists; Alice pays 10.5 ZC with sales tax");
  const stake = (await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "MIN_STAKE" })) as bigint;
  await recordTx("merchant: approve stake", await merchant.wallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "approve", args: [dep.merchants, stake] }));
  await recordTx("merchant: register", await merchant.wallet.writeContract({ chain: null, address: dep.merchants, abi: zipMerchantsAbi, functionName: "register", args: [merchant.account.address, stake, "e2e:Beautiful Plants"] }));
  const merchantId = (await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "merchantCount" })) as bigint;
  const taxBps = (await pub.readContract({ address: dep.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
  const base = ZC(10.5);
  const tax = (base * taxBps) / 10_000n;
  const [mBefore, tBefore, cBefore] = await Promise.all([balance(merchant.account.address), balance(treasury), balance(dep.couriers)]);
  note = await cleared(alice, (n) => n.value === ZC(1350), "Alice's change note");
  const payData = encodePayment({ merchantId, base, orderId: keccak256(toHex("table 4")), payeePrecommitment: 0n, identityCommitment: 0n, receipt: "0x", courier: noFee });
  await delivered("pay: merchant + sales tax", await spend(alice, note, alice.keys, base + tax, "pay", dep.pay, payData));
  check((await balance(merchant.account.address)) - mBefore === base, `the merchant received the 10.5 ZC base`);
  const [tAfter, cAfter] = await Promise.all([balance(treasury), balance(dep.couriers)]);
  check(tAfter - tBefore === (tax * 2000n) / 10_000n && cAfter - cBefore === (tax * 3000n) / 10_000n, `tax ${fmt(tax)} ZC split in real time (treasury 20%, couriers 30%, rest burned)`);

  console.log("\n5. Alice burns to speak, then burns at Bob's door");
  note = await cleared(alice, (n) => n.value === ZC(1350) - base - tax, "Alice's change note");
  const burnBefore = await balance("0x000000000000000000000000000000000000dEaD");
  const speech = encodeSpeech({ topic: keccak256(toHex("e2e")), groupId: 0n, message: "Whoever left tea at the archive node: thank you.", target: "someone near the archive", payload: "", courier: noFee });
  await delivered("speak: burn to be heard", await spend(alice, note, alice.keys, ZC(100), "speak", dep.broadcaster, speech));
  note = await cleared(alice, (n) => n.value === ZC(1250) - base - tax, "Alice's change note");
  const knock = encodeKnock({ door: bob.account.address, gift: 0n, message: "We should talk today.", courier: noFee });
  await delivered("knock: burn at a door", await spend(alice, note, alice.keys, ZC(120), "knock", dep.doorstep, knock));
  check((await balance("0x000000000000000000000000000000000000dEaD")) - burnBefore === ZC(220), "220 ZC burned across the two messages");

  console.log("\n6. Alice earns a badge from a zipped note");
  const identity = badgeIdentity(alice.keys);
  const ret = badgeReturnSecrets(alice.keys, 0n);
  note = await cleared(alice, (n) => n.value === ZC(1130) - base - tax, "Alice's change note");
  const lock = encodeLock({ identityCommitment: identity.commitment, duration: 30n * 86_400n, returnPrecommitment: hashPrecommitment(ret.nullifier, ret.secret), courier: noFee });
  await delivered("badge: lock from a note", await spend(alice, note, alice.keys, ZC(200), "lock", dep.badges, lock));
  const tier1 = (await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [0n] })) as bigint;
  const members = await groupMembers(pub, dep.semaphore, tier1, BigInt(dep.deployBlock));
  check(members.includes(identity.commitment), "Alice's identity joined the tier-1 group; no wallet is attached to it");

  console.log("\n7. Alice posts anonymously as a tier-1 holder");
  const day = BigInt(Math.floor(Number((await pub.getBlock()).timestamp) / 86_400));
  const text = "Tested my recovery keys today. Everyone should.";
  const postScope = (await pub.readContract({ address: dep.signal, abi: zipSignalAbi, functionName: "scopeOf", args: [tier1, day, 0n] })) as bigint;
  const postMsg = (await pub.readContract({ address: dep.signal, abi: zipSignalAbi, functionName: "messageOf", args: [text] })) as bigint;
  const postProof = await proveMembership(identity, members, postMsg, postScope);
  await delivered("post: anonymous board", await job("post", { args: [tier1, 0n, text, postProof] }));
  check(true, "the post landed with a membership proof, signed by nobody");

  console.log("\n8. Alice asks a poll from a note and answers it");
  note = await cleared(alice, (n) => n.value === ZC(930) - base - tax, "Alice's change note");
  const create = encodePollCreation({ groupId: tier1, question: "More lanterns on the Kalimar paths?\n0. yes\n1. no", optionCount: 2, duration: 3600n, burn: ZC(10), rewardPerVote: ZC(1), maxVotes: 3n, courier: noFee });
  await delivered("poll: create from a note", await spend(alice, note, alice.keys, ZC(13), "poll", dep.polls, create));
  const pollId = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "pollCount" })) as bigint;
  const rewardTo = privateKeyToAccount(generatePrivateKey()).address;
  const voteScope = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "scopeOf", args: [pollId] })) as bigint;
  const voteMsg = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "messageOf", args: [0, rewardTo] })) as bigint;
  const voteProof = await proveMembership(identity, members, voteMsg, voteScope);
  await delivered("poll: anonymous vote", await job("vote", { args: [pollId, 0, rewardTo, voteProof] }));
  check((await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "tally", args: [pollId, 0] })) === 1n, "the tally counts one anonymous answer");
  check((await balance(rewardTo)) === ZC(1), "the 1 ZC reward reached a fresh address");
  const again = await job("vote", { args: [pollId, 0, rewardTo, voteProof] }).then(
    () => false,
    () => true,
  );
  check(again, "a second answer from the same badge is refused");

  console.log("\n9. The courier holds an unzip and signs a receipt");
  // Held proofs must land before the epoch ends, so start near the top of an epoch to leave the courier room to wait
  await until("the start of a fresh epoch", async () => {
    const q = (await (await fetch(`${COURIER}/quote`)).json()) as { epochEnd: number };
    return q.epochEnd - Date.now() / 1000 > 45;
  }, 120);
  note = await cleared(alice, (n) => n.value === ZC(917) - base - tax, "Alice's change note");
  const dest = privateKeyToAccount(generatePrivateKey()).address;
  const held = await spend(alice, note, alice.keys, ZC(20), "relay", dep.entrypoint, encodeRelay(dest, courier, 0n), 8);
  check(held.status === "held" && !!held.receipt, "the courier is holding the unzip and returned a signed delivery receipt");
  const m = held.receipt!.message;
  const receipt = {
    message: { courier: m.courier as Address, nullifierHash: BigInt(m.nullifierHash), jobHash: m.jobHash as Hex, deadline: BigInt(m.deadline) },
    signature: held.receipt!.signature,
    target: held.receipt!.target,
    callData: held.receipt!.callData,
  };
  const signer = await recoverReceiptSigner(dep.couriers, dep.chainId, receipt.message, receipt.signature);
  check(signer.toLowerCase() === courier.toLowerCase(), "the receipt is signed by the courier (slashable if it fails to deliver)");
  check(receipt.target.toLowerCase() === dep.entrypoint.toLowerCase() && (await verifyReceipt(pub as never, dep.couriers, dep.chainId, receipt)), "the receipt binds the exact relay call (a report would deliver it)");
  const sent = await delivered("unzip: held by the courier", held);
  const at = (await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: sent.tx! })).blockNumber })).timestamp;
  check((await balance(dest)) === ZC(20) && at <= BigInt(held.deadline), "the held unzip arrived before its deadline");

  console.log("\n10. A month passes; the badge unlocks back into Alice's zip key");
  await pub.request({ method: "evm_increaseTime" as never, params: [31 * 86_400] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
  const siblings = [memberSiblings(await groupMembers(pub, dep.semaphore, tier1, BigInt(dep.deployBlock)), identity.commitment)];
  const lockId = (await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "lockCount" })) as bigint;
  await delivered("badge: unlock via courier", await job("unlock", { args: [lockId, siblings] }));
  const back = await cleared(alice, (n) => n.origin === "badge", "the badge return note", 1);
  check(back.value === ZC(200), "the 200 ZC stake came back as a note only Alice's key can spend");

  const final = await notesOf(alice, 1);
  const expected = ZC(1500) - ZC(100) - ZC(50) - base - tax - ZC(220) - ZC(200) - ZC(13) - ZC(20) + ZC(200);
  check(final.balance === expected, `Alice's zipped balance is exactly ${fmt(expected)} ZC`);

  writeGasTable();
  console.log(`\ne2e passed: ${checks} checks in ${((Date.now() - t0) / 1000).toFixed(0)}s; gas table in ${process.env.E2E_WRITE_GAS === "1" ? "docs" : ".local"}/GAS.md (E2E_WRITE_GAS=1 updates docs/)`);
}

function writeGasTable() {
  const prices = [1n, 5n, 20n];
  const rows = gas.map(({ step, gas: g }) => `| ${step} | ${g.toLocaleString("en-US")} | ${prices.map((p) => formatEther(g * p * 10n ** 9n).replace(/(\.\d{5})\d+$/, "$1")).join(" | ")} |`);
  const md = [
    "# Gas per action",
    "",
    "Measured by `./scripts/e2e.sh`: the gas each transaction in the end-to-end story really used on a local chain",
    "(including the 21,000 base and calldata). Spends carry a Groth16 proof, so their calldata is most of the difference",
    "between steps. ETH cost at 1, 5 and 20 gwei; multiply by the ETH price for dollars.",
    "",
    "Whoever submits pays the gas: for spends that's the courier, who recovers it through its fee.",
    "",
    `| Step | Gas | ETH @ 1 gwei | ETH @ 5 gwei | ETH @ 20 gwei |`,
    `|---|---:|---:|---:|---:|`,
    ...rows,
    "",
    `Generated ${new Date().toISOString().slice(0, 10)}.`,
    "",
  ].join("\n");
  // docs/GAS.md is tracked; only rewrite it when asked, so a plain run leaves the tree clean
  fs.writeFileSync(path.resolve(process.env.E2E_WRITE_GAS === "1" ? "docs/GAS.md" : ".local/GAS.md"), md); // e2e.sh runs from the repo root
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\ne2e FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
