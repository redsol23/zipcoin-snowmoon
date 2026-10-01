import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToBigInt, bytesToHex, hexToBytes, numberToBytes, type Hex } from "viem";

import type { NoteSecrets } from "./keys";

/**
 * Zip addresses: an X25519 key registered in ZipAddressRegistry so anyone can rezip coins to its owner. The sender
 * encrypts the new note's (nullifier, secret) to it; the recipient scans `Rezipped` events and keeps what decrypts.
 *
 * Ciphertext layout (136 bytes): ephemeral public key (32) | nonce (24) | sealed nullifier‖secret (64 + 16 tag).
 */

const INFO = new TextEncoder().encode("zipnet rezip v1");

/** Encryption keypair derived from the zip key's master secret, so one wallet signature recovers everything. */
export function zipAddressKeys(masterSecret: bigint) {
  const priv = hkdf(sha256, numberToBytes(masterSecret, { size: 32 }), undefined, new TextEncoder().encode("zipnet zip-address"), 32);
  return { privateKey: priv, publicKey: bytesToHex(x25519.getPublicKey(priv)) as Hex };
}

const toBytes32 = (x: bigint) => numberToBytes(x, { size: 32 });

export function sealSecrets(recipientPublicKey: Hex, s: NoteSecrets): Hex {
  const eph = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = hkdf(sha256, x25519.getSharedSecret(eph, hexToBytes(recipientPublicKey)), ephPub, INFO, 32);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const pt = new Uint8Array(64);
  pt.set(toBytes32(s.nullifier), 0);
  pt.set(toBytes32(s.secret), 32);
  const ct = xchacha20poly1305(key, nonce).encrypt(pt);
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return bytesToHex(out);
}

/** Returns the secrets if this ciphertext was sealed to `privateKey`, otherwise null. */
export function openSecrets(privateKey: Uint8Array, ciphertext: Hex): NoteSecrets | null {
  const b = hexToBytes(ciphertext);
  if (b.length !== 136) return null;
  try {
    const ephPub = b.slice(0, 32);
    const key = hkdf(sha256, x25519.getSharedSecret(privateKey, ephPub), ephPub, INFO, 32);
    const pt = xchacha20poly1305(key, b.slice(32, 56)).decrypt(b.slice(56));
    return { nullifier: bytesToBigInt(pt.slice(0, 32)), secret: bytesToBigInt(pt.slice(32, 64)) };
  } catch {
    return null;
  }
}

/**
 * Zip links: the note's secrets travel in the URL fragment (never sent to a server). Whoever opens the link can
 * unzip, so it behaves like cash in an envelope.
 */
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function zipLink(origin: string, s: NoteSecrets): string {
  const b = new Uint8Array(64);
  b.set(toBytes32(s.nullifier), 0);
  b.set(toBytes32(s.secret), 32);
  return `${origin.replace(/\/$/, "")}/claim#${b64url(b)}`;
}

export function parseZipLink(link: string): NoteSecrets | null {
  const frag = link.split("#")[1];
  if (!frag) return null;
  const b = unb64url(frag);
  if (b.length !== 64) return null;
  return { nullifier: bytesToBigInt(b.slice(0, 32)), secret: bytesToBigInt(b.slice(32, 64)) };
}

/**
 * Sealed envelopes: arbitrary bytes encrypted to an X25519 key, for courier-to-courier relaying. Same construction as
 * zip-address ciphertexts under its own HKDF label: ephemeral public key (32) | nonce (24) | XChaCha20-Poly1305 box.
 * Plaintexts are padded to a multiple of ENVELOPE_BUCKET bytes so an envelope's size doesn't reveal what's inside.
 */
const ENVELOPE_INFO = new TextEncoder().encode("zipnet envelope v1");
export const ENVELOPE_BUCKET = 4096;

/** A courier's (or a client's one-time) envelope keypair; deterministic from a 32-byte seed when one is given. */
export function envelopeKeys(seed?: Uint8Array) {
  const priv = seed ? hkdf(sha256, seed, undefined, ENVELOPE_INFO, 32) : x25519.utils.randomPrivateKey();
  return { privateKey: priv, publicKey: bytesToHex(x25519.getPublicKey(priv)) as Hex };
}

function pad(data: Uint8Array) {
  // 4-byte big-endian length, the data, then zeros up to the bucket boundary
  const size = Math.ceil((data.length + 4) / ENVELOPE_BUCKET) * ENVELOPE_BUCKET;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function unpad(padded: Uint8Array) {
  const n = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (n > padded.length - 4) throw new Error("bad padding");
  return padded.slice(4, 4 + n);
}

export function sealEnvelope(recipientPublicKey: Hex, plaintext: Uint8Array): Hex {
  const eph = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = hkdf(sha256, x25519.getSharedSecret(eph, hexToBytes(recipientPublicKey)), ephPub, ENVELOPE_INFO, 32);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ct = xchacha20poly1305(key, nonce).encrypt(pad(plaintext));
  const out = new Uint8Array(56 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return bytesToHex(out);
}

/** The plaintext if this envelope was sealed to `privateKey`, otherwise null. */
export function openEnvelope(privateKey: Uint8Array, envelope: Hex): Uint8Array | null {
  const b = hexToBytes(envelope);
  if (b.length < 56 + 16 + ENVELOPE_BUCKET) return null;
  try {
    const ephPub = b.slice(0, 32);
    const key = hkdf(sha256, x25519.getSharedSecret(privateKey, ephPub), ephPub, ENVELOPE_INFO, 32);
    return unpad(xchacha20poly1305(key, b.slice(32, 56)).decrypt(b.slice(56)));
  } catch {
    return null;
  }
}
