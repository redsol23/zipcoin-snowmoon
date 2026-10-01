// Who may talk to Emerald: a ZC holder. Server-only. Two ways in:
//   badge  - a Semaphore proof of membership in a ZipBadges tier group (anonymous; one nullifier per epoch)
//   wallet - an EIP-191 signature over a challenge, plus ZC.balanceOf(wallet) >= a minimum (links the wallet)
// Both return a short-lived HMAC session token. Chain access is injected (GateDeps), so every check runs in tests
// without a chain.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { MembershipProof } from "@zipnet/sdk";
import { isAddress, type Address, type Hex } from "viem";

import { EMERALD_MESSAGE, emeraldScope } from "./scope";

export type GateConfig = {
  chainId: number;
  /** Lowest badge tier accepted, numbered as the wallet shows them (1 = the first tier, ZipBadges.tierGroups(0)). */
  minTier: number;
  /** Plain-holding minimum, ZC wei. */
  minHoldWei: bigint;
  /** Badge proofs are scoped to floor(now / epochSec). */
  epochSec: number;
  /** HMAC key for session and challenge tokens. */
  secret: string;
  /** How long a badge or wallet session lasts. */
  sessionSec: number;
};

export type GateDeps = GateConfig & {
  now: () => number;
  /** Semaphore groupId of badge tier `tier` (1-based), or null if there is no such tier. */
  tierGroup: (tier: number) => Promise<bigint | null>;
  /** Semaphore.verifyProof(groupId, proof): the root is (recently) the group's and the zk proof checks out. */
  verifyBadgeProof: (groupId: bigint, proof: MembershipProof) => Promise<boolean>;
  /** ZC.balanceOf */
  balanceOf: (address: Address) => Promise<bigint>;
  /** EIP-191 (and ERC-1271 for contract wallets) signature check. */
  verifySignature: (address: Address, message: string, signature: Hex) => Promise<boolean>;
};

// ——— tokens ———

type Claims = { k: "badge" | "wallet" | "challenge"; exp: number; [x: string]: unknown };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(secret: string, claims: Claims) {
  const body = b64u(JSON.stringify(claims));
  return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}

export function verify(secret: string, token: string, now: number): Claims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    return typeof c.exp === "number" && c.exp > now ? c : null;
  } catch {
    return null;
  }
}

// ——— badge ———

export { EMERALD_MESSAGE, emeraldScope };

export const epochOf = (d: Pick<GateConfig, "epochSec">, now: number) => Math.floor(now / d.epochSec);

const big = (v: unknown) => {
  if (typeof v === "bigint") return v;
  if ((typeof v === "string" && /^\d{1,80}$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new Error("bad number");
};

function parseProof(p: unknown): MembershipProof | null {
  try {
    const o = p as Record<string, unknown>;
    if (!Array.isArray(o.points) || o.points.length !== 8) return null;
    return { merkleTreeDepth: big(o.merkleTreeDepth), merkleTreeRoot: big(o.merkleTreeRoot), nullifier: big(o.nullifier), message: big(o.message), scope: big(o.scope), points: o.points.map(big) };
  } catch {
    return null;
  }
}

export type Issued = { ok: true; token: string; kind: "badge" | "wallet"; expiresAt: number } | { ok: false; status: number; error: string };

/**
 * Anonymous holding. The proof must be for a tier group at or above the minimum, with Emerald's message, and scoped
 * to this chain and the current epoch (or the one just ended, so a proof made at the boundary still works). The
 * nullifier is per identity per epoch; a reused proof only reopens the same epoch's session.
 */
export async function issueBadgeSession(d: GateDeps, body: { tier?: unknown; proof?: unknown }): Promise<Issued> {
  const tier = typeof body.tier === "number" && Number.isInteger(body.tier) ? body.tier : -1;
  if (tier < d.minTier) return { ok: false, status: 403, error: `Emerald needs a tier ${d.minTier} badge or higher.` };
  const proof = parseProof(body.proof);
  if (!proof) return { ok: false, status: 400, error: "That isn't a Semaphore proof." };
  const now = d.now();
  const epoch = epochOf(d, now);
  const proofEpoch = [epoch, epoch - 1].find((e) => proof.scope === emeraldScope(d.chainId, e));
  if (proofEpoch === undefined) return { ok: false, status: 403, error: "That proof is for another app, chain or epoch. Make a fresh one." };
  if (proof.message !== EMERALD_MESSAGE) return { ok: false, status: 403, error: "That proof wasn't made for Emerald." };
  const group = await d.tierGroup(tier);
  if (group === null) return { ok: false, status: 403, error: "There is no such badge tier." };
  if (!(await d.verifyBadgeProof(group, proof).catch(() => false))) return { ok: false, status: 403, error: "The badge proof didn't verify." };
  // A session never outlives the epoch after the proof's, so an old proof can't be stretched
  const expiresAt = Math.min(now + d.sessionSec, (proofEpoch + 2) * d.epochSec);
  return { ok: true, kind: "badge", expiresAt, token: sign(d.secret, { k: "badge", exp: expiresAt, n: proof.nullifier.toString() }) };
}

// ——— wallet ———

const CHALLENGE_SEC = 300;

/** A sign-in message the server can recognise later without storing it: its nonce is an HMAC token. */
export function challengeFor(d: GateDeps, address: string): { message: string; expiresAt: number } | null {
  if (!isAddress(address)) return null;
  const expiresAt = d.now() + CHALLENGE_SEC;
  const nonce = sign(d.secret, { k: "challenge", exp: expiresAt, a: address.toLowerCase(), r: randomBytes(12).toString("hex") });
  const message = [
    "Sign in to Emerald, the zipnet wallet assistant.",
    "",
    "This links this wallet address to your Emerald session. Hold a badge to stay private instead.",
    "",
    `Address: ${address}`,
    `Chain: ${d.chainId}`,
    `Expires: ${new Date(expiresAt * 1000).toISOString()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
  return { message, expiresAt };
}

const usedNonces = new Map<string, number>();

/** Plain holding: a fresh signed challenge for this address, and at least the minimum ZC in it. */
export async function issueWalletSession(d: GateDeps, body: { address?: unknown; message?: unknown; signature?: unknown }): Promise<Issued> {
  const { address, message, signature } = body;
  if (typeof address !== "string" || !isAddress(address) || typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, status: 400, error: "Send the address, the challenge and its signature." };
  }
  const now = d.now();
  const nonce = /\nNonce: (\S+)$/.exec(message)?.[1] ?? "";
  const c = verify(d.secret, nonce, now);
  if (!c || c.k !== "challenge" || c.a !== address.toLowerCase() || !message.includes(`\nChain: ${d.chainId}\n`)) {
    return { ok: false, status: 403, error: "That challenge is expired or isn't ours. Ask for a new one." };
  }
  for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return { ok: false, status: 403, error: "That challenge was already used. Ask for a new one." };
  if (!(await d.verifySignature(address as Address, message, signature as Hex).catch(() => false))) return { ok: false, status: 403, error: "The signature doesn't match that address." };
  usedNonces.set(nonce, c.exp);
  const balance = await d.balanceOf(address as Address);
  if (balance < d.minHoldWei) return { ok: false, status: 402, error: "That wallet doesn't hold enough ZC for Emerald." };
  const expiresAt = now + d.sessionSec;
  return { ok: true, kind: "wallet", expiresAt, token: sign(d.secret, { k: "wallet", exp: expiresAt, a: address.toLowerCase() }) };
}

// ——— each chat request ———

/**
 * The session a bearer token belongs to, for per-session rate limits: a badge session (its nullifier) or a wallet
 * session (its address). Null without a valid token.
 */
export function sessionKey(d: Pick<GateConfig, "secret">, authorization: string | null, now: number): string | null {
  const bearer = authorization?.match(/^Bearer (\S+)$/)?.[1];
  const c = bearer ? verify(d.secret, bearer, now) : null;
  if (!c) return null;
  if (c.k === "badge") return `badge:${String(c.n)}`;
  if (c.k === "wallet") return `wallet:${String(c.a)}`;
  return null;
}

export type Authorized = { ok: true; via: "badge" | "wallet" } | { ok: false; status: 401 | 403; body: Record<string, unknown> };

/** Every way in, for the wallet's sign-in panel and for a refused request. */
export function accessOptions(d: GateDeps, error: string) {
  const epoch = epochOf(d, d.now());
  return {
    error,
    emerald: {
      badge: { private: true, minTier: d.minTier, chainId: d.chainId, epoch, scope: emeraldScope(d.chainId, epoch).toString(), message: EMERALD_MESSAGE.toString(), session: "/api/emerald/session" },
      wallet: { private: false, minHoldWei: d.minHoldWei.toString(), challenge: "/api/emerald/challenge", session: "/api/emerald/session", warning: "Signing in with a wallet links that wallet to Emerald." },
    },
  };
}

/** Checks one chat request: a session token (badge or wallet) covers any request until it expires. */
export function authorize(d: GateDeps, req: { authorization: string | null }): Authorized {
  const bearer = req.authorization?.match(/^Bearer (\S+)$/)?.[1] ?? null;
  if (bearer) {
    const c = verify(d.secret, bearer, d.now());
    if (c && (c.k === "badge" || c.k === "wallet")) return { ok: true, via: c.k };
    return { ok: false, status: 401, body: accessOptions(d, "Your Emerald session ended. Sign in again.") };
  }
  return { ok: false, status: 403, body: accessOptions(d, "Emerald is for ZC holders: hold a badge, or sign in with a wallet that holds ZC.") };
}
