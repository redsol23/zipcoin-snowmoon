/**
 * ZipSignal post slots, chosen locally (A-3).
 *
 * A badge holder gets SIGNAL_POSTS_PER_DAY posts per tier group per chain day; each slot is its own scope, so its own
 * nullifier. Finding a free slot by sending proofs until one doesn't revert would hand whoever simulates them (the
 * courier, and its RPC) the nullifiers of the slots already used, i.e. "this client wrote those posts too". So the
 * wallet computes its own nullifier for every slot and compares them with the day's `Posted` events, which it reads in
 * bulk like every other reader of the board (asking `nullifierUsed(n)` one nullifier at a time would tell the RPC the
 * same thing). Only one proof, for a slot known to be free, is ever sent.
 */
import type { Identity } from "@semaphore-protocol/core";
import type { Address } from "viem";

import { signalScope } from "./scopes";
import { semaphoreNullifier } from "./semaphore";

export const SIGNAL_POSTS_PER_DAY = 5;

/** This identity's nullifier for each of the day's slots in `groupId` (index = slot) */
export const signalSlotNullifiers = (identity: Identity, signal: Address, chainId: bigint | number, groupId: bigint, day: bigint) =>
  Array.from({ length: SIGNAL_POSTS_PER_DAY }, (_, s) => semaphoreNullifier(identity, signalScope(signal, chainId, groupId, day, BigInt(s))));

/**
 * A slot this identity hasn't used today, at random (so the slot number says nothing about how many it posted), or
 * null when all are used. `posted` holds the nullifiers of the day's `Posted` events in the group; `pending` holds
 * slots this device sent that may not be on chain yet.
 */
export function pickSignalSlot(
  identity: Identity,
  signal: Address,
  chainId: bigint | number,
  groupId: bigint,
  day: bigint,
  posted: Iterable<bigint>,
  pending: Iterable<number> = [],
  rand = Math.random,
): bigint | null {
  const seen = new Set(posted);
  const busy = new Set(pending);
  const free = signalSlotNullifiers(identity, signal, chainId, groupId, day)
    .map((n, s) => ({ n, s }))
    .filter(({ n, s }) => !seen.has(n) && !busy.has(s))
    .map(({ s }) => s);
  return free.length ? BigInt(free[Math.floor(rand() * free.length)]) : null;
}
