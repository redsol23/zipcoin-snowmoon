/**
 * ZipSignal's daily post slots. A member gets POSTS_PER_DAY posts per group per chain day: each proof's scope is
 * scopeOf(group, day, slot), and ZipSignal refuses a second proof with the same nullifier (same member and scope).
 * So a resident must never post twice in one slot, and a post must land on-chain on the day its scope names.
 */

export const POSTS_PER_DAY = 5;
export const DAY_SEC = 86_400;
/** Seconds a post may need, after the courier's hold, to be mined */
export const POST_MARGIN_SEC = 90;
/** Posts are only saved up to this many bytes on-chain (ZipSignal.MAX_MESSAGE_BYTES) */
export const MAX_POST_BYTES = 560;

const key = (day: bigint, groupId: bigint, slot: number) => `${day}:${groupId}:${slot}`;

/**
 * A slot the resident hasn't used today in this group, at random (so the slot says nothing about how many they posted),
 * or null when all are used. `used` holds "day:group:slot" keys.
 */
export function freeSlot(used: readonly string[], day: bigint, groupId: bigint, rand = Math.random): number | null {
  const free = Array.from({ length: POSTS_PER_DAY }, (_, s) => s).filter((s) => !used.includes(key(day, groupId, s)));
  return free.length ? free[Math.floor(rand() * free.length)] : null;
}

/** Records a slot as used, dropping keys from earlier days (they can't collide any more). */
export function useSlot(used: readonly string[], day: bigint, groupId: bigint, slot: number): string[] {
  return [...used.filter((k) => BigInt(k.split(":")[0]) >= day), key(day, groupId, slot)];
}

/**
 * The longest the courier may hold a post made at chain time `nowSec`: it must be mined before the day (and with it
 * the proof's scope) turns over. null = too close to midnight to post safely; wait for the new day.
 */
export function postHoldCap(nowSec: number, maxHoldSec: number): number | null {
  const left = DAY_SEC - (nowSec % DAY_SEC) - POST_MARGIN_SEC;
  return left < 0 ? null : Math.min(maxHoldSec, left);
}

/** Cuts text to at most `max` UTF-8 bytes without splitting a character. */
export function clipBytes(text: string, max = MAX_POST_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}
