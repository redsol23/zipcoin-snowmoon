import { randomBytes } from "node:crypto";
import { formatEther, keccak256, parseAbiItem, parseEther, toHex, type Address, type Hex } from "viem";

import {
  badgeRewardAccount,
  context,
  depositSecrets,
  emptyState,
  encodeKnock,
  encodePayment,
  encodePollCreation,
  encodeSend,
  encodeSpeech,
  entrypointAbi,
  groupMembers,
  hashPrecommitment,
  proveLeaf,
  proveMembership,
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
  type NoteSecrets,
  type PoolState,
} from "@zipnet/sdk";

import { JOB_GAS } from "./budget";
import { byId, CAST, shops, type Character } from "./cast";
import { clipBytes, DAY_SEC, freeSlot, postHoldCap, useSlot } from "./slots";
import { budget, cfg, facts, people, pub, saveFacts, txTransport, type Who } from "./world";

const { dep } = cfg;
const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

/** A resident's own wallet transaction. Checked against, and charged to, the daily gas budget at its real cost. */
const tx = async (who: Who, req: Record<string, unknown>) => {
  // Bootstrap (funding, shops, badges) is charged but never blocked: a restart must be able to finish it
  if (!bootstrapping) budget.check(300_000n * (await pub.getGasPrice()));
  const hash = await who.wallet.writeContract({ chain: null, ...req } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  budget.charge(r.gasUsed * r.effectiveGasPrice);
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return hash;
};

// ---------------------------------------------------------------------------------------------------------------
// shared chain view
// ---------------------------------------------------------------------------------------------------------------

let state: PoolState = emptyState();
let aspLabels: bigint[] = [];
/** Chain time at the last refresh (polls run on block time, not the wall clock) */
let chainNow = Math.floor(Date.now() / 1000);
/** Notes committed to a held courier job, so two actions never spend the same note. nullifier → release time */
const reserved = new Map<bigint, number>();

export async function refresh() {
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  const r = (await (await fetch(`${cfg.courierUrl}/asp`)).json()) as { labels: string[] };
  aspLabels = r.labels.map(BigInt);
  chainNow = Number((await pub.getBlock()).timestamp);
  const spent = new Set(state.withdrawals.map((w) => w.spentNullifier));
  for (const [n, until] of reserved) if (until < Date.now() || spent.has(n)) reserved.delete(n);
}

const residentAddresses = new Set([...people.values()].map((w) => w.account.address.toLowerCase()));
const isResident = (a: Address) => residentAddresses.has(a.toLowerCase());
const idOf = (who: Who) => [...people].find(([, w]) => w === who)![0];
/** Zip links a resident holds: savings deposited under secrets only they know */
const linksOf = (id: string): NoteSecrets[] => (facts.links[id] ?? []).map((l) => ({ nullifier: BigInt(l.n), secret: BigInt(l.s) }));
function newLink(id: string) {
  const s = randomSecrets();
  (facts.links[id] ??= []).push({ n: s.nullifier.toString(), s: s.secret.toString() });
  saveFacts();
  return hashPrecommitment(s.nullifier, s.secret);
}

export function zipped(who: Who) {
  const { notes, nextDepositIndex } = recoverNotes(who.keys, dep.scope, state, { zipAddressKey: who.zipAddress.privateKey, links: linksOf(idOf(who)) });
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

/**
 * Hands a job to the courier, held for a random while so the timing says nothing about who acted. These are the same
 * job kinds (and fees) the wallet uses, so residents grow the same anonymity sets real users hide in. The courier pays
 * the gas; it counts against Veridia's daily budget at the courier's estimate.
 */
async function viaCourier(kind: string, body: Record<string, unknown>, note?: Note, maxHoldSec = cfg.maxHoldSec) {
  const cost = (JOB_GAS[kind] ?? 900_000n) * (await pub.getGasPrice());
  budget.check(cost);
  const holdSec = Math.floor(Math.random() * maxHoldSec);
  const res = await fetch(`${cfg.courierUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind, holdSec, ...body }),
  });
  const j = (await res.json()) as { id?: string; tx?: string; error?: string; deadline?: number };
  if (!res.ok) throw new Error(j.error ?? `courier ${res.status}`);
  budget.charge(cost);
  if (note) reserved.set(note.nullifier, (j.deadline ? j.deadline * 1000 : Date.now()) + 60_000);
  return j;
}

let quoteCache: { at: number; courier: Address; fees: Record<string, bigint> } | null = null;
/** The courier's address and its fee for a job kind (what the wallet pays; 0 on a courier that charges nothing) */
async function courierFor(kind: string) {
  if (!quoteCache || Date.now() - quoteCache.at > 60_000) {
    const q = (await (await fetch(`${cfg.courierUrl}/quote`)).json()) as { courier: Address; fees?: Record<string, string | number> };
    quoteCache = { at: Date.now(), courier: q.courier, fees: Object.fromEntries(Object.entries(q.fees ?? {}).map(([k, v]) => [k, BigInt(v)])) };
  }
  return { feeRecipient: quoteCache.courier, fee: quoteCache.fees[kind] ?? 0n };
}

/** Spends one note for `net` (plus the courier's fee) through a processooor */
async function spendVia(who: Who, kind: string, processooor: Address, net: bigint, encode: (courier: { feeRecipient: Address; fee: bigint }) => Hex, why: string) {
  const courier = await courierFor(kind);
  const n = pickNote(who, net + courier.fee);
  if (!n) throw new Skip(why);
  const data = encode(courier);
  return viaCourier(kind, { withdrawal: { processooor, data }, proof: await prove(who, n, net + courier.fee, processooor, data) }, n);
}

const zc = (x: number) => parseEther(x.toString());
const human = (x: bigint) => Number(formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const cycleSec = () => BigInt(Math.max(120, Math.round(cfg.cycleMin * 60)));

// ---------------------------------------------------------------------------------------------------------------
// everyday actions
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
  // Paid exactly the way the wallet pays: a random order id (a guessable one would name the payer), no receipt text
  // and no identity commitment on-chain (the resident's commitment is also in their badge lock, which would link them)
  const orderId = keccak256(randomBytes(32));
  const j = await spendVia(
    who,
    "pay",
    dep.pay,
    base + tax,
    (courier) =>
      encodePayment({
        merchantId: BigInt(facts.merchantId[shopId]),
        base,
        orderId,
        payeePrecommitment: 0n,
        identityCommitment: 0n,
        receipt: "0x",
        courier,
      }),
    "not enough zipped coins for this meal",
  );
  return { detail: { shop: shop.shop!.name, item, base: human(base), tax: human(tax) }, job: j.id };
}

export async function allowance(c: Character, toId: string, amount: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const to = people.get(toId)!;
  const key = (await pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [to.account.address] })) as Hex;
  if (/^0x0+$/.test(key)) throw new Skip(`${toId} has no zip address yet`);
  const s = randomSecrets();
  const j = await spendVia(
    who,
    "rezip",
    dep.rezip,
    amount,
    (courier) => encodeSend({ precommitment: hashPrecommitment(s.nullifier, s.secret), ciphertext: sealSecrets(key, s), courier }),
    "not enough zipped coins to send",
  );
  return { detail: { to: byId.get(toId)!.name, amount: human(amount) }, job: j.id };
}

let minBurn: bigint | null = null;
export const burnFloor = async () => (minBurn ??= (await pub.readContract({ address: dep.broadcaster, abi: zipBroadcasterAbi, functionName: "MIN_BURN" })) as bigint);

export async function knock(c: Character, toId: string, message: string): Promise<Outcome> {
  const who = people.get(c.id)!;
  const door = people.get(toId)!.account.address;
  const burn = (await burnFloor()) + zc(Math.floor(Math.random() * 50));
  const j = await spendVia(
    who,
    "knock",
    dep.doorstep,
    burn,
    (courier) => encodeKnock({ door, gift: 0n, message: message.slice(0, 280), courier }),
    "not enough zipped coins to burn at a door",
  );
  return { detail: { door: byId.get(toId)!.name, burned: human(burn) }, job: j.id };
}

export async function speak(c: Character, message: string, target: string, groupId = 0n, minimum?: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = (minimum ?? (await burnFloor())) + zc(Math.floor(Math.random() * 100));
  const j = await spendVia(
    who,
    "speak",
    dep.broadcaster,
    burn,
    (courier) =>
      // The same topic the wallet speaks on, so a resident's broadcast doesn't label itself
      encodeSpeech({ topic: keccak256(toHex("zipnet")), groupId, message: message.slice(0, 280), target: target.slice(0, 120), payload: "", courier }),
    "not enough zipped coins to be heard",
  );
  return { detail: { burned: human(burn), target, groupId: groupId.toString() }, job: j.id };
}

/** A message addressed to one person: a broadcast that names them as its target */
export async function message(c: Character, toId: string, text: string): Promise<Outcome> {
  const to = people.get(toId)!.account.address;
  const out = await speak(c, text, to, 0n);
  return { ...out, detail: { ...out.detail, to: byId.get(toId)!.name } };
}

async function semProof(who: Who, groupId: bigint, message: bigint, scope: bigint) {
  const members = await groupMembers(pub, dep.semaphore, groupId, BigInt(dep.deployBlock));
  if (!members.includes(who.semaphore.commitment)) throw new Skip("not a member of that group");
  return proveMembership(who.semaphore, members, message, scope);
}

export async function tierGroup(i = 0) {
  return (await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [BigInt(i)] })) as bigint;
}

/** Anonymous post in a group: "some tier-1 badge holder says…" */
export async function post(c: Character, text: string, groupId?: bigint): Promise<Outcome> {
  const who = people.get(c.id)!;
  const g = groupId ?? (await tierGroup(0));
  // The contract's day is block time, not the wall clock (a local chain can run ahead of it)
  const now = Number((await pub.getBlock()).timestamp);
  const day = BigInt(Math.floor(now / DAY_SEC));
  const hold = postHoldCap(now, cfg.maxHoldSec);
  if (hold === null) throw new Skip("the board's day is about to turn over");
  // A second proof in a slot this resident already used today would carry the same nullifier and be refused
  const used = facts.posted[c.id] ?? [];
  const slot = freeSlot(used, day, g);
  if (slot === null) throw new Skip("already posted as often as the board allows today");
  text = clipBytes(text);
  const scope = (await pub.readContract({ address: dep.signal, abi: zipSignalAbi, functionName: "scopeOf", args: [g, day, BigInt(slot)] })) as bigint;
  const message = BigInt(keccak256(toHex(text)));
  const proof = await semProof(who, g, message, scope);
  // Spent as soon as the proof exists: if the courier took it but we never heard back, the slot may be used on-chain
  facts.posted[c.id] = useSlot(used, day, g, slot);
  saveFacts();
  const j = await viaCourier("post", { args: [g, BigInt(slot), text, proof] }, undefined, hold);
  return { detail: { groupId: g.toString(), anonymous: true }, job: j.id };
}

// ---------------------------------------------------------------------------------------------------------------
// polls: a public founder's paid poll, or an anonymous one asked from a zipped note
// ---------------------------------------------------------------------------------------------------------------

const pollText = (question: string, options: string[]) => `${question}\n${options.map((o, i) => `${i}. ${o}`).join("\n")}`;

export async function createPoll(c: Character, question: string, options: string[]): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = zc(200);
  const reward = zc(5);
  const maxVotes = 20n;
  await tx(who, { address: dep.zc, abi: erc20, functionName: "approve", args: [dep.polls, burn + reward * maxVotes] });
  const hash = await tx(who, {
    address: dep.polls,
    abi: zipPollsAbi,
    functionName: "create",
    args: [await tierGroup(0), pollText(question, options), options.length, 3600n, burn, reward, maxVotes],
  });
  return { detail: { question, options, burned: human(burn) }, tx: hash };
}

/** Ask the badge holders something without saying who asks: burn and rewards come from a zipped note */
export async function askAnon(c: Character, question: string, options: string[]): Promise<Outcome> {
  const who = people.get(c.id)!;
  const burn = zc(20 + Math.floor(Math.random() * 30));
  const reward = zc(1);
  const maxVotes = 8n;
  const groupId = await tierGroup(0);
  const text = pollText(question, options);
  const j = await spendVia(
    who,
    "poll",
    dep.polls,
    burn + reward * maxVotes,
    (courier) => encodePollCreation({ groupId, question: text, optionCount: options.length, duration: cycleSec(), burn, rewardPerVote: reward, maxVotes, courier }),
    "not enough zipped coins to ask anonymously",
  );
  facts.asked.push(keccak256(toHex(text)));
  saveFacts();
  return { detail: { question, options, burned: human(burn), anonymous: true }, job: j.id };
}

const pollCreated = parseAbiItem(
  "event PollCreated(uint256 indexed pollId, uint256 indexed groupId, address indexed creator, uint256 burned, uint256 rewardPerVote, uint256 maxVotes, uint64 endsAt, uint8 optionCount, string question)",
);
/**
 * Open polls Veridia's own people asked. Residents stay out of real users' polls: they
 * would skew real answers and take real rewards. They share the job kinds and anonymity sets, not the outcomes.
 */
export async function openPolls() {
  const logs = await pub.getLogs({ address: dep.polls, event: pollCreated, fromBlock: BigInt(dep.deployBlock) });
  return logs
    .filter((l) => Number(l.args.endsAt) > chainNow)
    .filter((l) => isResident(l.args.creator!) || facts.asked.includes(keccak256(toHex(l.args.question!))))
    .map((l) => ({ pollId: l.args.pollId!, groupId: l.args.groupId!, question: l.args.question!, optionCount: Number(l.args.optionCount) }));
}

export async function vote(c: Character, pollId: bigint, option: number): Promise<Outcome> {
  const who = people.get(c.id)!;
  const poll = (await openPolls()).find((p) => p.pollId === pollId);
  if (!poll) throw new Skip("that poll is closed");
  if (option < 0 || option >= poll.optionCount) throw new Skip("no such option");
  if (facts.voted[c.id]?.includes(pollId.toString())) throw new Skip("already answered that poll");
  const scope = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "scopeOf", args: [pollId] })) as bigint;
  // The reward goes where the wallet sends users' rewards: an address derived from the zip key, linked to no wallet
  // (rewarding the resident's own wallet would sign the anonymous answer with it)
  const rewardTo = badgeRewardAccount(who.keys).address;
  const message = (await pub.readContract({ address: dep.polls, abi: zipPollsAbi, functionName: "messageOf", args: [option, rewardTo] })) as bigint;
  const proof = await semProof(who, poll.groupId, message, scope);
  const j = await viaCourier("vote", { args: [pollId, option, rewardTo, proof] });
  (facts.voted[c.id] ??= []).push(pollId.toString());
  saveFacts();
  return { detail: { pollId: pollId.toString(), option }, job: j.id };
}

export class Skip extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// bootstrap: fund, register zip addresses, open shops, zip savings, earn a badge. Idempotent.
// ---------------------------------------------------------------------------------------------------------------

let bootstrapping = false;

/**
 * The part of a resident's purse they live on privately: a random 60-80% (whole coins) of what public actions (a
 * badge lock) leave. Random, so the purses in cast.ts don't say how much of the treasury's deposits is whose.
 */
const pooledShare = (c: Character) => (c.shop ? 0n : zc(Math.floor((c.purse - (c.purse >= 400 ? 100 : 0)) * (0.6 + Math.random() * 0.2))));

/**
 * Deposits the residents' private savings from the treasury: whole-coin chunks of random size, residents taken in
 * random order and interleaved, each chunk to a precommitment only that resident holds (a zip link). On-chain these
 * are treasury deposits: an observer sees Veridia put coins in the pool, not which resident each deposit belongs to,
 * and no resident wallet makes them. Resumable: progress is saved after every chunk.
 */
async function seedPool(tWallet: { writeContract: (a: never) => Promise<Hex> }) {
  const send = (req: Record<string, unknown>) => tWallet.writeContract({ chain: null, ...req } as never).then((hash) => pub.waitForTransactionReceipt({ hash }));
  for (let ids = Object.keys(facts.seed); ids.length; ids = Object.keys(facts.seed)) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const s = facts.seed[id];
    const left = BigInt(s.target) - BigInt(s.done);
    // Between a fifth and a half of the resident's total; the remainder goes in one piece once it is small
    const r = zc(Math.floor((0.2 + Math.random() * 0.3) * Number(formatEther(BigInt(s.target)))));
    const amount = r === 0n || left <= r + zc(20) ? left : r;
    if (amount > 0n) {
      const pre = newLink(id);
      await send({ address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, amount] });
      const receipt = await send({ address: dep.entrypoint, abi: entrypointAbi, functionName: "deposit", args: [dep.zc, amount, pre] });
      if (receipt.status !== "success") throw new Error(`treasury deposit for ${id} reverted`);
      s.done = (BigInt(s.done) + amount).toString();
    }
    if (BigInt(s.done) >= BigInt(s.target)) delete facts.seed[id];
    saveFacts();
  }
}

export async function bootstrap() {
  bootstrapping = true;
  try {
    await setup();
  } finally {
    bootstrapping = false;
  }
}

async function setup() {
  const treasury = cfg.treasuryKey ? (await import("viem/accounts")).privateKeyToAccount(cfg.treasuryKey) : null;
  const tWallet = treasury ? (await import("viem")).createWalletClient({ account: treasury, transport: txTransport }) : null;

  for (const c of CAST) {
    const who = people.get(c.id)!;
    if (!facts.funded.includes(c.id)) {
      if (!tWallet) throw new Error("TREASURY_KEY needed to fund the cast the first time");
      // The wallet only gets gas and what public actions need (badge lock, merchant stake, public polls).
      // The savings a resident spends privately go straight from the treasury into the pool (seedPool, after this
      // loop), so no resident wallet deposits its own savings.
      const pooled = pooledShare(c);
      await pub.waitForTransactionReceipt({ hash: await tWallet.sendTransaction({ chain: null, to: who.account.address, value: parseEther(cfg.residentEth) }) });
      await pub.waitForTransactionReceipt({
        hash: await tWallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "transfer", args: [who.account.address, zc(c.purse) - pooled] }),
      });
      facts.funded.push(c.id);
      facts.seed[c.id] = { target: pooled.toString(), done: "0" };
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

  if (tWallet && Object.keys(facts.seed).length) await seedPool(tWallet as never);
  else if (Object.keys(facts.seed).length) console.warn("[veridia] some residents' savings are still to be deposited; set TREASURY_KEY to finish");

  await refresh();
  // A resident with nothing zipped (a cast funded before the treasury seeded savings) zips part of their wallet
  for (const c of CAST.filter((x) => !x.shop)) {
    const who = people.get(c.id)!;
    const z = zipped(who);
    if (z.balance + BigInt(z.pending) === 0n && !facts.seed[c.id]) {
      const w = await walletZc(who);
      if (w > zc(20)) await zip(c, (w * 7n) / 10n);
    }
  }
  await refresh();
}

export { shops };
