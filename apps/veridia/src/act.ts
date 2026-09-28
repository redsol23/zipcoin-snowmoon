import { generateProof, Group } from "@semaphore-protocol/core";
import { formatEther, keccak256, parseAbiItem, parseEther, toHex, type Address, type Hex } from "viem";

import {
  context,
  depositSecrets,
  emptyState,
  encodeKnock,
  encodePayment,
  encodeSend,
  encodeSpeech,
  entrypointAbi,
  groupMembers,
  hashPrecommitment,
  proveLeaf,
  proveSpend,
  randomSecrets,
  recoverNotes,
  sealSecrets,
  syncPool,
  toJson,
  withdrawalSecrets,
  zipAddressRegistryAbi,
  zipBadgesAbi,
  zipBroadcasterAbi,
  zipMerchantsAbi,
  zipPayAbi,
  zipPollsAbi,
  zipSignalAbi,
  type Note,
  type PoolState,
} from "@zipnet/sdk";

import { byId, CAST, shops, type Character } from "./cast";
import { cfg, facts, people, pub, saveFacts, type Who } from "./world";

const { dep } = cfg;
const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const tx = async (who: Who, req: Record<string, unknown>) => {
  const hash = await who.wallet.writeContract({ chain: null, ...req } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return hash;
};

// ---------------------------------------------------------------------------------------------------------------
// shared chain view
// ---------------------------------------------------------------------------------------------------------------

let state: PoolState = emptyState();
let aspLabels: bigint[] = [];
/** Notes committed to a held courier job, so two actions never spend the same note. nullifier → release time */
const reserved = new Map<bigint, number>();

export async function refresh() {
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  const r = (await (await fetch(`${cfg.courierUrl}/asp`)).json()) as { labels: string[] };
  aspLabels = r.labels.map(BigInt);
  const spent = new Set(state.withdrawals.map((w) => w.spentNullifier));
  for (const [n, until] of reserved) if (until < Date.now() || spent.has(n)) reserved.delete(n);
}

export function zipped(who: Who) {
  const { notes, nextDepositIndex } = recoverNotes(who.keys, dep.scope, state, { zipAddressKey: who.zipAddress.privateKey });
  const usable = notes.filter((n) => aspLabels.includes(n.label) && !reserved.has(n.nullifier));
  return { usable, balance: usable.reduce((a, n) => a + n.value, 0n), nextDepositIndex, pending: notes.length - usable.length };
}

export const walletZc = async (who: Who) =>
  (await pub.readContract({ address: dep.zc, abi: erc20, functionName: "balanceOf", args: [who.account.address] })) as bigint;

function pickNote(who: Who, amount: bigint): Note | null {
  const fits = zipped(who).usable.filter((n) => n.value >= amount);
  return fits.length ? fits[Math.floor(Math.random() * fits.length)] : null;
}

async function prove(who: Who, n: Note, amount: bigint, processooor: Address, data: Hex) {
  const next = withdrawalSecrets(who.keys, n.label, n.children);
  return proveSpend({
    value: n.value,
    label: n.label,
    nullifier: n.nullifier,
    secret: n.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor, data }, dep.scope),
    state: proveLeaf(state.leaves, n.commitment),
    asp: proveLeaf(aspLabels, n.label),
  });
}

/** Hands a job to the courier, held for a random while so the timing says nothing about who acted. */
async function viaCourier(kind: string, body: Record<string, unknown>, note?: Note) {
  const holdSec = Math.floor(Math.random() * cfg.maxHoldSec);
  const res = await fetch(`${cfg.courierUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind, holdSec, ...body }),
  });
  const j = (await res.json()) as { id?: string; tx?: string; error?: string; deadline?: number };
  if (!res.ok) throw new Error(j.error ?? `courier ${res.status}`);
  if (note) reserved.set(note.nullifier, (j.deadline ? j.deadline * 1000 : Date.now()) + 60_000);
  return j;
}

let quoteCache: { at: number; courier: Address } | null = null;
async function courierAddress(): Promise<Address> {
  if (!quoteCache || Date.now() - quoteCache.at > 60_000) {
    const q = (await (await fetch(`${cfg.courierUrl}/quote`)).json()) as { courier: Address };
    quoteCache = { at: Date.now(), courier: q.courier };
  }
  return quoteCache.courier;
}

const zc = (x: number) => parseEther(x.toString());
const human = (x: bigint) => Number(formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------------------------

export type Outcome = { detail: Record<string, unknown>; tx?: string; job?: string };

export async function zip(c: Character, amount: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const s = depositSecrets(who.keys, dep.scope, zipped(who).nextDepositIndex);
  await tx(who, { address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, amount] });
  const hash = await tx(who, {
    address: dep.entrypoint,
    abi: entrypointAbi,
    functionName: "deposit",
    args: [dep.zc, amount, hashPrecommitment(s.nullifier, s.secret)],
  });
  return { detail: { amount: human(amount) }, tx: hash };
}

let taxBps: bigint | null = null;
export async function eat(c: Character, shopId: string, item: string): Promise<Outcome> {
  const who = people.get(c.id)!;
  const shop = byId.get(shopId)!;
  const price = shop.shop!.menu.find(([n]) => n === item)?.[1] ?? shop.shop!.menu[0][1];
  taxBps ??= (await pub.readContract({ address: dep.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
  const base = zc(price);
  const tax = (base * taxBps) / 10_000n;
  const n = pickNote(who, base + tax);
  if (!n) throw new Skip("not enough zipped coins for this meal");
  const payment = {
    merchantId: BigInt(facts.merchantId[shopId]),
    base,
    orderId: keccak256(toHex(`${c.id}/${shopId}/${Date.now()}`)),
    payeePrecommitment: 0n,
    identityCommitment: who.semaphore.commitment,
    receipt: toHex(`${item}`),
    courier: { feeRecipient: await courierAddress(), fee: 0n },
  };
  const data = encodePayment(payment);
  const j = await viaCourier("pay", { withdrawal: { processooor: dep.pay, data }, proof: await prove(who, n, base + tax, dep.pay, data) }, n);
  return { detail: { shop: shop.shop!.name, item, base: human(base), tax: human(tax) }, job: j.id };
}

export async function allowance(c: Character, toId: string, amount: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const to = people.get(toId)!;
  const key = (await pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [to.account.address] })) as Hex;
  if (/^0x0+$/.test(key)) throw new Skip(`${toId} has no zip address yet`);
  const n = pickNote(who, amount);
  if (!n) throw new Skip("not enough zipped coins to send");
  const s = randomSecrets();
  const data = encodeSend({ precommitment: hashPrecommitment(s.nullifier, s.secret), ciphertext: sealSecrets(key, s), courier: { feeRecipient: await courierAddress(), fee: 0n } });
  const j = await viaCourier("rezip", { withdrawal: { processooor: dep.rezip, data }, proof: await prove(who, n, amount, dep.rezip, data) }, n);
  return { detail: { to: byId.get(toId)!.name, amount: human(amount) }, job: j.id };
}

let minBurn: bigint | null = null;
const burnFloor = async () => (minBurn ??= (await pub.readContract({ address: dep.broadcaster, abi: zipBroadcasterAbi, functionName: "MIN_BURN" })) as bigint);

export async function knock(c: Character, toId: string, message: string): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = (await burnFloor()) + zc(Math.floor(Math.random() * 50));
  const n = pickNote(who, burn);
  if (!n) throw new Skip("not enough zipped coins to burn at a door");
  const door = people.get(toId)!.account.address;
  const data = encodeKnock({ door, gift: 0n, message: message.slice(0, 280), courier: { feeRecipient: await courierAddress(), fee: 0n } });
  const j = await viaCourier("knock", { withdrawal: { processooor: dep.doorstep, data }, proof: await prove(who, n, burn, dep.doorstep, data) }, n);
  return { detail: { door: byId.get(toId)!.name, burned: human(burn) }, job: j.id };
}

export async function speak(c: Character, message: string, target: string, groupId = 0n): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = (await burnFloor()) + zc(Math.floor(Math.random() * 100));
  const n = pickNote(who, burn);
  if (!n) throw new Skip("not enough zipped coins to be heard");
  const data = encodeSpeech({
    topic: keccak256(toHex("veridia")),
    groupId,
    message: message.slice(0, 280),
    target: target.slice(0, 120),
    payload: "",
    courier: { feeRecipient: await courierAddress(), fee: 0n },
  });
  const j = await viaCourier("speak", { withdrawal: { processooor: dep.broadcaster, data }, proof: await prove(who, n, burn, dep.broadcaster, data) }, n);
  return { detail: { burned: human(burn), target, groupId: groupId.toString() }, job: j.id };
}

async function semProof(who: Who, groupId: bigint, message: bigint, scope: bigint) {
  const members = await groupMembers(pub, dep.semaphore, groupId);
  if (!members.includes(who.semaphore.commitment)) throw new Skip("not a member of that group");
  const p = await generateProof(who.semaphore, new Group(members), message, scope);
  return { ...p, merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map(BigInt) };
}

export async function tierGroup(i = 0) {
  return (await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [BigInt(i)] })) as bigint;
}

/** Anonymous post in a group: "some tier-1 badge holder says…" */
export async function post(c: Character, text: string, groupId?: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const g = groupId ?? (await tierGroup(0));
  const day = BigInt(Math.floor(Date.now() / 86_400_000));
  const slot = BigInt(Math.floor(Math.random() * 5));
  const scope = (await pub.readContract({ address: dep.signal, abi: zipSignalAbi, functionName: "scopeOf", args: [day, slot] })) as bigint;
  const message = BigInt(keccak256(toHex(text)));
  const proof = await semProof(who, g, message, scope);
  const j = await viaCourier("post", { args: [g, slot, text, proof] });
  return { detail: { groupId: g.toString(), anonymous: true }, job: j.id };
}

export async function createPoll(c: Character, question: string, options: string[]): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = zc(200);
  const reward = zc(5);
  const maxVotes = 20n;
  await tx(who, { address: dep.zc, abi: erc20, functionName: "approve", args: [dep.polls, burn + reward * maxVotes] });
  const text = `${question}\n${options.map((o, i) => `${i}. ${o}`).join("\n")}`;
  const hash = await tx(who, {
    address: dep.polls,
    abi: zipPollsAbi,
    functionName: "create",
    args: [await tierGroup(0), text, options.length, 3600n, burn, reward, maxVotes],
  });
  return { detail: { question, options, burned: human(burn) }, tx: hash };
}

const pollCreated = parseAbiItem(
  "event PollCreated(uint256 indexed pollId, uint256 indexed groupId, address indexed creator, uint256 burned, uint256 rewardPerVote, uint256 maxVotes, uint64 endsAt, uint8 optionCount, string question)",
);
export async function openPolls() {
  const logs = await pub.getLogs({ address: dep.polls, event: pollCreated, fromBlock: BigInt(dep.deployBlock) });
  const now = Math.floor(Date.now() / 1000);
  return logs
    .filter((l) => Number(l.args.endsAt) > now)
    .map((l) => ({ pollId: l.args.pollId!, groupId: l.args.groupId!, question: l.args.question!, optionCount: Number(l.args.optionCount) }));
}

export async function vote(c: Character, pollId: bigint, option: number): Promise<Outcome> {
  const who = people.get(c.id)!;
  const poll = (await openPolls()).find((p) => p.pollId === pollId);
  if (!poll) throw new Skip("that poll is closed");
  const scope = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "scopeOf", args: [pollId] })) as bigint;
  const message = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "messageOf", args: [option, who.account.address] })) as bigint;
  const proof = await semProof(who, poll.groupId, message, scope);
  const j = await viaCourier("vote", { args: [pollId, option, who.account.address, proof] });
  return { detail: { pollId: pollId.toString(), option }, job: j.id };
}

export class Skip extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// bootstrap: fund, register zip addresses, open shops, zip savings, earn a badge. Idempotent.
// ---------------------------------------------------------------------------------------------------------------

export async function bootstrap() {
  const treasury = cfg.treasuryKey ? (await import("viem/accounts")).privateKeyToAccount(cfg.treasuryKey) : null;
  const tWallet = treasury ? (await import("viem")).createWalletClient({ account: treasury, transport: (await import("viem")).http(cfg.rpcUrl) }) : null;

  for (const c of CAST) {
    const who = people.get(c.id)!;
    if (!facts.funded.includes(c.id)) {
      if (!tWallet) throw new Error("TREASURY_KEY needed to fund the cast the first time");
      await pub.waitForTransactionReceipt({ hash: await tWallet.sendTransaction({ chain: null, to: who.account.address, value: parseEther("0.5") }) });
      await pub.waitForTransactionReceipt({
        hash: await tWallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "transfer", args: [who.account.address, zc(c.purse)] }),
      });
      facts.funded.push(c.id);
      saveFacts();
    }

    const key = (await pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [who.account.address] })) as Hex;
    if (key !== who.zipAddress.publicKey) await tx(who, { address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "setKey", args: [who.zipAddress.publicKey] });

    if (c.shop && !facts.merchantId[c.id]) {
      const stake = (await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "MIN_STAKE" })) as bigint;
      await tx(who, { address: dep.zc, abi: erc20, functionName: "approve", args: [dep.merchants, stake] });
      await tx(who, { address: dep.merchants, abi: zipMerchantsAbi, functionName: "register", args: [who.account.address, stake, `veridia:${c.shop.name}`] });
      facts.merchantId[c.id] = ((await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "merchantCount" })) as bigint).toString();
      saveFacts();
    }

    if (!c.shop && c.purse >= 400 && !facts.badged.includes(c.id)) {
      const lock = zc(100);
      const r = randomSecrets();
      await tx(who, { address: dep.zc, abi: erc20, functionName: "approve", args: [dep.badges, lock] });
      await tx(who, {
        address: dep.badges,
        abi: zipBadgesAbi,
        functionName: "lock",
        args: [lock, who.semaphore.commitment, 30n * 86_400n, hashPrecommitment(r.nullifier, r.secret)],
      });
      facts.badged.push(c.id);
      saveFacts();
    }
  }

  await refresh();
  for (const c of CAST.filter((x) => !x.shop)) {
    const who = people.get(c.id)!;
    const z = zipped(who);
    if (z.balance + BigInt(z.pending) === 0n) {
      const w = await walletZc(who);
      if (w > zc(20)) await zip(c, (w * 7n) / 10n);
    }
  }
  await refresh();
}

export { shops };
