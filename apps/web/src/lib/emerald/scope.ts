// Emerald's badge-proof scope and message, shared by the server gate (gate.ts) and the wallet that proves. The wallet
// computes both here and never proves over a scope or message the server sends (A-9): a compromised endpoint could
// otherwise hand it an on-chain action's scope and message and get a usable proof back.
import { encodeAbiParameters, keccak256, toHex } from "viem";

export const EMERALD_MESSAGE = BigInt(keccak256(toHex("zipnet.emerald.session")));

/** Scope of a badge proof: Emerald, this chain, this epoch. Same shape as ZipSignal.scopeOf (abi.encode + keccak). */
export const emeraldScope = (chainId: number, epoch: number) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "uint256" }], ["zipnet.emerald", BigInt(chainId), BigInt(epoch)])));
