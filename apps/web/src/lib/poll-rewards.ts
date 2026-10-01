// Where a poll answer's reward goes. ZipPolls pays it as a plain ZC transfer to an address named in the answer, and
// that address is public in the Voted event. Paying the connected wallet would put it next to an anonymous answer, so
// by default every answer gets its own fresh address derived from the zip key: one per poll, never reused, controlled
// only by the zip key's holder.
import { mnemonicToAccount } from "viem/accounts";
import type { Address } from "viem";

/** BIP-44 account 7 of the zip key's phrase is reserved for poll rewards; the address index is the poll id. */
const REWARD_ACCOUNT = 7;

export function pollRewardAccount(phrase: string, pollId: bigint) {
  const index = Number(pollId % 2_147_483_648n); // non-hardened range
  return mnemonicToAccount(phrase.trim().toLowerCase().split(/\s+/).join(" "), { path: `m/44'/60'/${REWARD_ACCOUNT}'/0/${index}` });
}

export const pollRewardAddress = (phrase: string, pollId: bigint): Address => pollRewardAccount(phrase, pollId).address;

/** True when `to` is one of the addresses the app must never name in an anonymous answer. */
export function isLinkedAddress(to: string, linked: (string | null | undefined)[]) {
  const t = to.toLowerCase();
  return linked.some((a) => !!a && a.toLowerCase() === t);
}
