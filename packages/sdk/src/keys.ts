/**
 * Zip keys. A zip key is a 12-word phrase; from it come the master keys and every note's secrets.
 *
 * `masterKeys`, `depositSecrets` and `withdrawalSecrets` follow `generateMasterKeys`, `generateDepositSecrets` and
 * `generateWithdrawalSecrets` in @0xbow/privacy-pools-core-sdk (crypto.ts, Apache-2.0) exactly, so a phrase made here
 * recovers the same notes in any Privacy Pools wallet.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { poseidon1, poseidon3 } from "poseidon-lite";
import { bytesToBigInt, hexToBytes, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { SNARK_SCALAR_FIELD } from "./tree";

export type MasterKeys = { masterNullifier: bigint; masterSecret: bigint };
export type NoteSecrets = { nullifier: bigint; secret: bigint };

/** The message a wallet signs to derive its zip key. Changing it changes every derived key, so it is versioned. */
export const ZIP_MESSAGE =
  "zipnet: unlock my zip key (v1)\n\nThis signature derives the key to your zipped coins and your zip address. It never leaves this device.\n\nOnly sign this on a zipnet app you trust.";

function canonical(phrase: string) {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isMnemonic(phrase: string) {
  return validateMnemonic(canonical(phrase), wordlist);
}

/**
 * The zip key of a wallet: 128 bits of entropy expanded from its signature over ZIP_MESSAGE with HKDF-SHA256.
 * Wallets sign deterministically, so the same wallet always gets back the same phrase and the same coins.
 */
export function mnemonicFromSignature(signature: Hex) {
  const entropy = hkdf(sha256, hexToBytes(signature), undefined, new TextEncoder().encode("zipnet zip key v1"), 16);
  return entropyToMnemonic(entropy, wordlist);
}

const hdKey = (phrase: string, accountIndex: number) =>
  bytesToBigInt(mnemonicToAccount(phrase, { accountIndex }).getHdKey().privateKey!);

/** masterNullifier = Poseidon(key of account 0), masterSecret = Poseidon(key of account 1). */
export function masterKeys(phrase: string): MasterKeys {
  const p = canonical(phrase);
  return { masterNullifier: poseidon1([hdKey(p, 0)]), masterSecret: poseidon1([hdKey(p, 1)]) };
}

/** Secrets of this key's `index`-th deposit into the pool identified by `scope`. */
export function depositSecrets(k: MasterKeys, scope: bigint, index: bigint): NoteSecrets {
  return { nullifier: poseidon3([k.masterNullifier, scope, index]), secret: poseidon3([k.masterSecret, scope, index]) };
}

/** Secrets of the change note left by the `index`-th partial spend of the note with `label`. */
export function withdrawalSecrets(k: MasterKeys, label: bigint, index: bigint): NoteSecrets {
  return { nullifier: poseidon3([k.masterNullifier, label, index]), secret: poseidon3([k.masterSecret, label, index]) };
}

/** Uniformly random secrets below the field, for zip links (their secrets travel in the URL, not in a key). */
export function randomSecrets(): NoteSecrets {
  const draw = () => bytesToBigInt(crypto.getRandomValues(new Uint8Array(32))) % SNARK_SCALAR_FIELD;
  return { nullifier: draw(), secret: draw() };
}
