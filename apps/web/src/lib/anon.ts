"use client";

// The wallet's anonymous Voice actions: a Semaphore proof made in this browser from the zip key, handed to a courier
// that sends it on-chain. The courier sees a proof, never a wallet address.
import {
  groupMembers,
  isRootExpiredError,
  pickSignalSlot,
  pollScope as zipPollScope,
  proverIn,
  proveMembership,
  semaphoreNullifier,
  signalScope,
  toJson,
} from "@zipnet/sdk";
import type { Identity } from "@semaphore-protocol/core";
import { encodeAbiParameters, isAddress, keccak256, parseAbiItem, toHex, type Address, type PublicClient } from "viem";

import type { Config } from "./wallet";
import { isLinkedAddress } from "./poll-rewards";

/** Posts and answers carry no fee, so they go to the courier as plain jobs. */
export async function freeJob(c: Config, kind: "vote" | "post", args: unknown[]) {
  const res = await fetch(`${c.courierUrl}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ kind, args, holdSec: 0 }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  if (j.status === "failed") throw new Error("The courier sent it, but it failed on-chain. Nothing changed; try again.");
  return j as { id: string; status: string; tx?: string };
}

/** ZipPolls.scopeOf, computed here: keccak256(abi.encode("zipnet.poll", polls, chainId, pollId)). */
export const pollScope = (config: Config, pollId: bigint) => zipPollScope(config.deployment.polls, config.deployment.chainId, pollId);

/** ZipPolls.messageOf: keccak256(abi.encode(option, rewardTo)). */
export const pollMessage = (option: number, rewardTo: Address) => BigInt(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [option, rewardTo])));

/** Whether one of these badge identities already answered: its nullifier for the poll's scope is among the answers. Local only. */
export const answeredBy = (config: Config, identities: Identity[], pollId: bigint, nullifiers: bigint[]) =>
  identities.some((i) => nullifiers.includes(semaphoreNullifier(i, pollScope(config, pollId))));

export async function answerPoll(
  c: { config: Config; pub: PublicClient; provers: Identity[] },
  poll: { id: bigint; groupId: bigint },
  option: number,
  rewardTo: Address,
  neverName: (string | null)[],
): Promise<void> {
  if (!isAddress(rewardTo)) throw new Error("The reward address isn't valid.");
  if (isLinkedAddress(rewardTo, neverName)) throw new Error("That's your connected wallet. Naming it in an answer would tie the answer to your account; use the fresh address instead.");
  for (let attempt = 0; ; attempt++) {
    const members = await groupMembers(c.pub, c.config.deployment.semaphore, poll.groupId, BigInt(c.config.deployment.deployBlock));
    // The first of the wallet's live-lock identities (highest tier first) that is in the poll's group (A-8)
    const identity = proverIn(c.provers, members);
    if (!identity) throw new Error("This poll asks a badge tier you don't hold yet.");
    const proof = await proveMembership(identity, members, pollMessage(option, rewardTo), pollScope(c.config, poll.id));
    try {
      await freeJob(c.config, "vote", [poll.id, option, rewardTo, proof]);
      return;
    } catch (e) {
      if (attempt === 0 && isRootExpiredError(e)) continue; // the group changed under the proof (A-5): prove again
      if (/simulation reverted/i.test((e as Error).message)) throw new Error("You've already answered this poll, or it has closed.");
      throw e;
    }
  }
}

const DAY = 86_400;
const posted = parseAbiItem("event Posted(uint256 indexed groupId, uint256 indexed day, uint256 nullifier, string message)");

// Slots this device sent a post in (per signal contract, group and day) that may not be indexed yet. Local only.
const PENDING = "zipnet.signalSlots";
function pendingSlots(tag: string): number[] {
  try {
    return (JSON.parse(window.localStorage.getItem(PENDING) ?? "{}") as Record<string, number[]>)[tag] ?? [];
  } catch {
    return [];
  }
}
function markSlot(tag: string, day: bigint, slot: number) {
  try {
    const all = JSON.parse(window.localStorage.getItem(PENDING) ?? "{}") as Record<string, number[]>;
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => BigInt(k.split(":")[2]) >= day - 1n));
    kept[tag] = [...(kept[tag] ?? []), slot];
    window.localStorage.setItem(PENDING, JSON.stringify(kept));
  } catch {
    /* no storage: the day's Posted events still cover every slot that landed */
  }
}

/**
 * A board post as "some tier-N holder": five slots per badge per chain day, each its own nullifier. The free slot is
 * found here, from this identity's nullifiers and the day's Posted events (A-3): probing slots through the courier
 * would show it which earlier posts are ours. Exactly one proof is sent.
 */
export async function postToBoard(c: { config: Config; pub: PublicClient; provers: Identity[] }, groupId: bigint, text: string) {
  if (!text.trim()) throw new Error("Write something first.");
  const dep = c.config.deployment;
  const members = await groupMembers(c.pub, dep.semaphore, groupId, BigInt(dep.deployBlock));
  const identity = proverIn(c.provers, members);
  if (!identity) throw new Error("You need that badge tier to post as it.");
  const now = Number((await c.pub.getBlock()).timestamp);
  const day = BigInt(Math.floor(now / DAY));
  const tag = `${dep.signal.toLowerCase()}:${groupId}:${day}`;
  const logs = await c.pub.getLogs({ address: dep.signal, event: posted, args: { groupId, day }, fromBlock: BigInt(dep.deployBlock) });
  const slot = pickSignalSlot(identity, dep.signal, dep.chainId, groupId, day, logs.map((l) => l.args.nullifier!), pendingSlots(tag));
  if (slot === null) throw new Error("You've used today's five posts for this badge. Try again tomorrow.");
  const scope = signalScope(dep.signal, dep.chainId, groupId, day, slot);
  let proof = await proveMembership(identity, members, BigInt(keccak256(toHex(text))), scope);
  try {
    try {
      await freeJob(c.config, "post", [groupId, slot, text, proof]);
    } catch (e) {
      if (!isRootExpiredError(e)) throw e;
      // The group changed under the proof (A-5); nothing was spent, so the same slot is still free: prove again
      proof = await proveMembership(identity, await groupMembers(c.pub, dep.semaphore, groupId, BigInt(dep.deployBlock)), BigInt(keccak256(toHex(text))), scope);
      await freeJob(c.config, "post", [groupId, slot, text, proof]);
    }
    markSlot(tag, day, Number(slot));
  } catch (e) {
    if (!/simulation reverted/i.test((e as Error).message) || isRootExpiredError(e)) throw e;
    // Used after all (a post from another device not indexed yet, or the day turned): don't try the next slot here
    markSlot(tag, day, Number(slot));
    throw new Error("That post slot was just used, perhaps from another device, or the day turned over. Press Post again in a moment.");
  }
}
