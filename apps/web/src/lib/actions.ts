"use client";

import {
  encodeBatchRelay,
  encodeKnock,
  encodePayment,
  encodeRelay,
  encodeSend,
  encodeSpeech,
  hashPrecommitment,
  randomSecrets,
  sealSecrets,
  zipAddressRegistryAbi,
  zipBroadcasterAbi,
  zipLink,
  zipPayAbi,
  type MasterKeys,
} from "@zipnet/sdk";
import { formatEther, isAddress, keccak256, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { chooseCourierUrl } from "./couriers";
import { withoutPending } from "./pending-spends";
import { courierQuote, myNotes, pickNote, spend, spendBatch, zip as zipDeposit, type Config, type JobResult, type Pool } from "./wallet";

/**
 * Every wallet action, as plain functions. The forms and Emerald both call these, so a confirmed Emerald proposal
 * does exactly what the matching form would.
 */

export type Ctx = {
  config: Config;
  pub: PublicClient;
  wallet: WalletClient | null;
  keys: MasterKeys;
  pool: Pool;
  notes: ReturnType<typeof myNotes>;
  walletZc: bigint;
  refresh: () => Promise<void>;
};

export type Done = { text: string; link?: string };

const zc = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

export const when = (j: JobResult) =>
  j.tx
    ? `Sent on-chain in transaction ${j.tx.slice(0, 10)}…`
    : `The courier will send it by ${new Date(j.deadline * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}, at a random moment. It signed a promise to.`;

/** Fees from a stake-weighted courier; that same courier carries the job, since the fee is addressed to it. */
const quoteFor = async (c: Ctx) => courierQuote(c.config, await chooseCourierUrl(c.config, c.pub));

async function spendFromNotes(c: Ctx, amount: bigint, kind: string, processooor: Address, data: Hex, holdSec: number, courierUrl: string) {
  const note = pickNote(c.notes.spendable, amount);
  if (!note) throw new Error(`Your largest cleared note holds ${zc(c.notes.largest)} ZC. One action spends one note, so send less or zip more first.`);
  const job = await spend(c.config, c.keys, c.pool, note, amount, kind, processooor, data, holdSec, courierUrl);
  setTimeout(c.refresh, 3000);
  // A job the courier sent that reverted on-chain comes back "failed": never report it as done
  if (job.status === "failed") throw new Error(`The courier sent it, but it failed on-chain${job.tx ? ` (transaction ${job.tx.slice(0, 10)}…)` : ""}. Nothing was spent; try again.`);
  return job;
}

export async function doZip(c: Ctx, amount: bigint): Promise<Done> {
  if (!c.wallet) throw new Error("Connect a wallet first.");
  if (amount > c.walletZc) throw new Error(`Your wallet holds ${zc(c.walletZc)} ZC.`);
  await zipDeposit(c.config, c.pub, c.wallet, c.keys, c.notes.nextDepositIndex, amount);
  await c.refresh();
  return { text: `Zipped ${zc(amount)} ZC. It becomes spendable once the postman clears it at the next epoch.` };
}

export async function doSend(c: Ctx, amount: bigint, to: string | null, holdSec: number): Promise<Done> {
  const s = randomSecrets();
  let ciphertext: Hex = "0x";
  if (to) {
    if (!isAddress(to)) throw new Error("Enter the recipient's address, or make a link instead.");
    const key = (await c.pub.readContract({ address: c.config.deployment.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [to] })) as Hex;
    if (/^0x0+$/.test(key)) throw new Error("That address hasn't set up a zip address yet. Send them a link instead.");
    ciphertext = sealSecrets(key, s);
  }
  const q = await quoteFor(c);
  const fee = q.fee("rezip");
  const data = encodeSend({ precommitment: hashPrecommitment(s.nullifier, s.secret), ciphertext, courier: { feeRecipient: q.courier, fee } });
  const job = await spendFromNotes(c, amount + fee, "rezip", c.config.deployment.rezip, data, holdSec, q.url);
  if (!to) return { text: `Link ready. Whoever opens it can claim ${zc(amount)} ZC, so share it like cash. ${when(job)}`, link: zipLink(window.location.origin, s) };
  return { text: `${zc(amount)} ZC is on its way to ${to.slice(0, 8)}…; it stays inside the pool the whole time. ${when(job)}` };
}

export async function taxOn(c: Ctx, base: bigint) {
  const bps = (await c.pub.readContract({ address: c.config.deployment.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
  return (base * bps) / 10_000n;
}

export async function doPay(c: Ctx, merchantId: bigint, base: bigint, orderId?: Hex): Promise<Done> {
  const tax = await taxOn(c, base);
  const q = await quoteFor(c);
  const data = encodePayment({
    merchantId,
    base,
    orderId: orderId ?? keccak256(toHex(`${Date.now()}-${Math.random()}`)),
    payeePrecommitment: 0n,
    identityCommitment: 0n,
    receipt: "0x",
    courier: { feeRecipient: q.courier, fee: q.fee("pay") },
  });
  const job = await spendFromNotes(c, base + tax + q.fee("pay"), "pay", c.config.deployment.pay, data, 0, q.url);
  return { text: `Payment succeeded. Base ${zc(base)} zc, tax ${zc(tax)} zc, total ${zc(base + tax)} zc. The merchant knows it was paid; nobody knows by whom. ${when(job)}` };
}

export async function doUnzip(c: Ctx, amount: bigint, to: Address, holdSec: number): Promise<Done> {
  if (!isAddress(to)) throw new Error("Enter a destination address.");
  const q = await quoteFor(c);
  if (!pickNote(c.notes.spendable, amount) && c.config.deployment.batchRelayer) return combineAndUnzip(c, q, amount, to, holdSec);
  const fee = q.fee("relay");
  const bps = fee === 0n ? 0n : (fee * 10_000n + amount - 1n) / amount;
  const job = await spendFromNotes(c, amount, "relay", c.config.deployment.entrypoint, encodeRelay(to, q.courier, bps), holdSec, q.url);
  return { text: `${zc(amount)} ZC will arrive at ${to.slice(0, 8)}… with no link to where it came from. ${when(job)}` };
}

/**
 * No single note covers the amount but several do: unzip them together through the BatchRelayer, largest notes first.
 * That one transaction shows the notes belong to the same person (not who), so the result says so.
 */
async function combineAndUnzip(c: Ctx, q: Awaited<ReturnType<typeof courierQuote>>, amount: bigint, to: Address, holdSec: number): Promise<Done> {
  const parts: { note: (typeof c.notes.spendable)[number]; amount: bigint }[] = [];
  let left = amount;
  for (const n of withoutPending(c.notes.spendable).sort((a, b) => (a.value > b.value ? -1 : 1))) {
    if (left === 0n || parts.length === 10) break;
    const take = n.value < left ? n.value : left;
    parts.push({ note: n, amount: take });
    left -= take;
  }
  if (left > 0n) throw new Error(`Your cleared notes can move ${zc(amount - left)} ZC in one go at most.`);
  const fee = q.fee("batch") * BigInt(parts.length);
  const bps = fee === 0n ? 0n : (fee * 10_000n + amount - 1n) / amount;
  const data = encodeBatchRelay({ recipient: to, feeRecipient: q.courier, relayFeeBPS: bps, batchSize: parts.length, totalValue: amount });
  const job = await spendBatch(c.config, c.keys, c.pool, parts, data, holdSec, q.url);
  setTimeout(c.refresh, 3000);
  return {
    text: `${zc(amount)} ZC will arrive at ${to.slice(0, 8)}…, combined from ${parts.length} notes in one transaction. Anyone can see those notes were spent together, though not by whom. ${when(job)}`,
  };
}

export async function minBurn(c: Pick<Ctx, "config" | "pub">) {
  return (await c.pub.readContract({ address: c.config.deployment.broadcaster, abi: zipBroadcasterAbi, functionName: "MIN_BURN" })) as bigint;
}

export async function doSpeak(c: Ctx, burn: bigint, message: string, target: string, holdSec: number): Promise<Done> {
  const min = await minBurn(c);
  if (burn < min) throw new Error(`The smallest burn is ${zc(min)} ZC.`);
  if (!message) throw new Error("Write a message first.");
  const q = await quoteFor(c);
  const data = encodeSpeech({ topic: keccak256(toHex("zipnet")), groupId: 0n, message, target, payload: "", courier: { feeRecipient: q.courier, fee: q.fee("speak") } });
  const job = await spendFromNotes(c, burn + q.fee("speak"), "speak", c.config.deployment.broadcaster, data, holdSec, q.url);
  return { text: `${zc(burn)} ZC will burn to carry your words, signed by nobody. ${when(job)}` };
}

export async function doKnock(c: Ctx, door: Address, burn: bigint, gift: bigint, message: string): Promise<Done> {
  if (!isAddress(door)) throw new Error("Enter whose door.");
  const q = await quoteFor(c);
  const data = encodeKnock({ door, gift, message, courier: { feeRecipient: q.courier, fee: q.fee("knock") } });
  const job = await spendFromNotes(c, burn + gift + q.fee("knock"), "knock", c.config.deployment.doorstep, data, 0, q.url);
  return { text: `${zc(burn)} ZC will burn at their door${gift ? `, with a gift of ${zc(gift)} ZC` : ""}. If they subscribed with a courier, their phone buzzes. ${when(job)}` };
}
