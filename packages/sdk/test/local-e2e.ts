/**
 * SDK end-to-end against the local stack (run ./scripts/local-up.sh first):
 *   zip → index → recover → rezip to a zip address → recipient recovers the note → unzip via relay.
 *   node node_modules/tsx/dist/cli.mjs test/local-e2e.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  buildTree,
  context,
  depositSecrets,
  emptyState,
  encodeRelay,
  encodeSend,
  entrypointAbi,
  hashPrecommitment,
  masterKeys,
  parseDeployment,
  proveLeaf,
  proveSpend,
  randomSecrets,
  recoverNotes,
  sealSecrets,
  syncPool,
  withdrawalSecrets,
  zipAddressKeys,
  zipAddressRegistryAbi,
  zipRezipAbi,
  type MasterKeys,
  type Note,
  type PoolState,
} from "../src/index";

const root = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".local/dev.env"), "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const dep = parseDeployment(fs.readFileSync(path.resolve(root, env.DEPLOYMENT), "utf8"));
const dev = privateKeyToAccount(env.DEV_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: foundry, transport: http(env.RPC_URL) });
const wallet = createWalletClient({ account: dev, chain: foundry, transport: http(env.RPC_URL) });
const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const send = async (req: Parameters<typeof wallet.writeContract>[0]) => {
  if (process.env.DEBUG) console.log("tx", (req as { functionName: string }).functionName);
  const hash = await wallet.writeContract(req as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx failed ${hash}`);
  return r;
};

/** The dev account is the local postman: approve every label seen so far. */
const aspLabels: bigint[] = [];
async function approve(state: PoolState) {
  for (const d of state.deposits) if (!aspLabels.includes(d.label)) aspLabels.push(d.label);
  await send({ address: dep.entrypoint, abi: entrypointAbi, functionName: "updateRoot", args: [buildTree(aspLabels).root, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"] } as never);
}

async function spend(k: MasterKeys, note: Note, amount: bigint, processooor: Address, data: Hex, state: PoolState) {
  const next = withdrawalSecrets(k, note.label, note.children);
  return proveSpend({
    value: note.value,
    label: note.label,
    nullifier: note.nullifier,
    secret: note.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor, data }, dep.scope),
    state: proveLeaf(state.leaves, note.commitment),
    asp: proveLeaf(aspLabels, note.label),
  });
}

async function main() {
  const t0 = Date.now();
  const seila = masterKeys("test test test test test test test test test test test junk");
  const febric = masterKeys("legal winner thank year wave sausage worth useful legal winner thank yellow");

  // Febric registers a zip address
  const febricZip = zipAddressKeys(febric.masterSecret);
  const febricAcct = privateKeyToAccount(generatePrivateKey());
  await wallet.sendTransaction({ to: febricAcct.address, value: parseEther("1") });
  const febricWallet = createWalletClient({ account: febricAcct, chain: foundry, transport: http(env.RPC_URL) });
  await pub.waitForTransactionReceipt({
    hash: await febricWallet.writeContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "setKey", args: [febricZip.publicKey] }),
  });

  // Seila zips 500 ZC (her first deposit index isn't known up front: recover first)
  let state = await syncPool(pub, dep, emptyState(), { fromBlock: BigInt(dep.deployBlock) });
  const i = recoverNotes(seila, dep.scope, state).nextDepositIndex;
  const s = depositSecrets(seila, dep.scope, i);
  await send({ address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, parseEther("500")] } as never);
  await send({ address: dep.entrypoint, abi: entrypointAbi, functionName: "deposit", args: [dep.zc, parseEther("500"), hashPrecommitment(s.nullifier, s.secret)] } as never);
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  await approve(state);

  const mine = recoverNotes(seila, dep.scope, state);
  const note = mine.notes.find((n) => n.nullifier === s.nullifier)!;
  console.log(`seila recovered ${mine.notes.length} note(s), balance ${mine.balance / 10n ** 18n} ZC`);

  // Rezip 120 ZC to Febric's zip address: seila → pool → febric, never leaving the pool
  const onchainKey = (await pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [febricAcct.address] })) as Hex;
  const gift = randomSecrets();
  const data = encodeSend({ precommitment: hashPrecommitment(gift.nullifier, gift.secret), ciphertext: sealSecrets(onchainKey, gift), courier: { feeRecipient: dev.address, fee: parseEther("1") } });
  const proof = await spend(seila, note, parseEther("121"), dep.rezip, data, state);
  await send({ address: dep.rezip, abi: zipRezipAbi, functionName: "rezip", args: [{ processooor: dep.rezip, data }, proof] } as never);
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  await approve(state);

  const his = recoverNotes(febric, dep.scope, state, { zipAddressKey: febricZip.privateKey });
  const got = his.notes.find((n) => n.origin === "received" && n.nullifier === gift.nullifier);
  if (!got || got.value !== parseEther("120")) throw new Error("febric did not recover the rezipped note");
  console.log(`febric found a received note of ${got.value / 10n ** 18n} ZC by decrypting Rezipped events`);
  const change = recoverNotes(seila, dep.scope, state).notes.find((n) => n.label === note.label)!;
  console.log(`seila's change note: ${change.value / 10n ** 18n} ZC (same label, fresh secrets)`);

  // Febric unzips 50 to a fresh address through a relay
  const dest = privateKeyToAccount(generatePrivateKey()).address;
  const relayData = encodeRelay(dest, dev.address, 0n);
  const p2 = await spend(febric, got, parseEther("50"), dep.entrypoint, relayData, state);
  await send({ address: dep.entrypoint, abi: entrypointAbi, functionName: "relay", args: [{ processooor: dep.entrypoint, data: relayData }, p2, dep.scope] } as never);
  const bal = (await pub.readContract({ address: dep.zc, abi: erc20, functionName: "balanceOf", args: [dest] })) as bigint;
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  const left = recoverNotes(febric, dep.scope, state, { zipAddressKey: febricZip.privateKey }).notes.find((n) => n.label === got.label)!;
  console.log(`febric unzipped ${bal / 10n ** 18n} ZC to a fresh address; ${left.value / 10n ** 18n} ZC still zipped`);
  if (bal !== parseEther("50") || left.value !== parseEther("70")) throw new Error("balances off");
  console.log(`ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
