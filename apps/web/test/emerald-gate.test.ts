import type { MembershipProof } from "@zipnet/sdk";
import { keccak256, parseEther, toHex, verifyMessage, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  authorize,
  challengeFor,
  EMERALD_MESSAGE,
  emeraldScope,
  issueBadgeSession,
  issueWalletSession,
  sign,
  verify,
  type GateDeps,
} from "../src/lib/emerald/gate";

const T0 = 1_800_000_000;
const EPOCH = 14_400;
const GROUPS: Record<number, bigint> = { 1: 11n, 2: 22n, 3: 33n };
const account = privateKeyToAccount(keccak256(toHex("emerald test wallet")));

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    chainId: 1,
    minTier: 1,
    minHoldWei: parseEther("100000"),
    epochSec: EPOCH,
    secret: "s".repeat(40),
    sessionSec: 3600,
    now: () => T0,
    tierGroup: async (t) => GROUPS[t] ?? null,
    verifyBadgeProof: async (g, p) => g === 22n && p.merkleTreeRoot === 7n,
    balanceOf: async () => parseEther("250000"),
    verifySignature: (address, message, signature) => verifyMessage({ address, message, signature }),
    ...over,
  };
}

const proof = (over: Partial<MembershipProof> = {}): MembershipProof => ({
  merkleTreeDepth: 3n,
  merkleTreeRoot: 7n,
  nullifier: 99n,
  message: EMERALD_MESSAGE,
  scope: emeraldScope(1, Math.floor(T0 / EPOCH)),
  points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
  ...over,
});
// Proofs travel as JSON with decimal strings
const wire = (p: MembershipProof) => JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const req = (o: { authorization?: string } = {}) => ({ authorization: o.authorization ?? null });

describe("tokens", () => {
  it("round-trip, and refuse tampering, other keys and expiry", () => {
    const t = sign("k".repeat(32), { k: "badge", exp: T0 + 10 });
    expect(verify("k".repeat(32), t, T0)).toMatchObject({ k: "badge" });
    expect(verify("x".repeat(32), t, T0)).toBeNull();
    expect(verify("k".repeat(32), t, T0 + 10)).toBeNull();
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "badge", exp: T0 + 99999 })).toString("base64url");
    expect(verify("k".repeat(32), `${forged}.${mac}`, T0)).toBeNull();
    expect(verify("k".repeat(32), body, T0)).toBeNull();
  });
});

describe("badge sign-in (anonymous)", () => {
  it("accepts a proof for a tier at or above the minimum, scoped to this chain and epoch", async () => {
    const r = await issueBadgeSession(deps(), { tier: 2, proof: wire(proof()) });
    expect(r).toMatchObject({ ok: true, kind: "badge" });
    if (r.ok) expect(r.expiresAt).toBe(T0 + 3600);
  });
  it("still accepts the epoch that just ended, but never lets the session outlive the next one", async () => {
    const d = deps({ now: () => (Math.floor(T0 / EPOCH) + 1) * EPOCH + 5 });
    const r = await issueBadgeSession(d, { tier: 2, proof: wire(proof()) });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.expiresAt).toBeLessThanOrEqual((Math.floor(T0 / EPOCH) + 2) * EPOCH);
  });
  it("refuses other scopes: another epoch, another chain, another app", async () => {
    const e = Math.floor(T0 / EPOCH);
    for (const scope of [emeraldScope(1, e - 2), emeraldScope(1, e + 1), emeraldScope(5, e), 12345n]) {
      expect(await issueBadgeSession(deps(), { tier: 2, proof: wire(proof({ scope })) })).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("refuses a low tier, a wrong message, a bad proof or junk", async () => {
    expect(await issueBadgeSession(deps({ minTier: 3 }), { tier: 2, proof: wire(proof()) })).toMatchObject({ ok: false, error: expect.stringMatching(/tier 3/) });
    expect(await issueBadgeSession(deps(), { tier: 2, proof: wire(proof({ message: 1n })) })).toMatchObject({ ok: false });
    expect(await issueBadgeSession(deps(), { tier: 2, proof: wire(proof({ merkleTreeRoot: 8n })) })).toMatchObject({ ok: false, error: expect.stringMatching(/didn't verify/) });
    expect(await issueBadgeSession(deps(), { tier: 9, proof: wire(proof()) })).toMatchObject({ ok: false, error: expect.stringMatching(/no such/) });
    expect(await issueBadgeSession(deps(), { tier: 2, proof: { points: [1] } })).toMatchObject({ ok: false, status: 400 });
    expect(await issueBadgeSession(deps({ verifyBadgeProof: async () => Promise.reject(new Error("revert")) }), { tier: 2, proof: wire(proof()) })).toMatchObject({ ok: false });
  });
});

describe("wallet sign-in (links the wallet)", () => {
  const signIn = async (d: GateDeps, over: { message?: string; address?: Address } = {}) => {
    const c = challengeFor(d, account.address)!;
    const message = over.message ?? c.message;
    return issueWalletSession(d, { address: over.address ?? account.address, message, signature: await account.signMessage({ message }) });
  };
  it("says plainly that it links the wallet", () => {
    expect(challengeFor(deps(), account.address)!.message).toMatch(/links this wallet/);
    expect(challengeFor(deps(), "0x123")).toBeNull();
  });
  it("issues a session for a fresh signed challenge and enough ZC", async () => {
    expect(await signIn(deps())).toMatchObject({ ok: true, kind: "wallet" });
  });
  it("refuses too little ZC", async () => {
    expect(await signIn(deps({ balanceOf: async () => parseEther("99999") }))).toMatchObject({ ok: false, status: 402 });
  });
  it("refuses an edited, expired, reused or foreign challenge", async () => {
    const d = deps();
    const c = challengeFor(d, account.address)!;
    const edited = c.message.replace("Chain: 1", "Chain: 5");
    expect(await issueWalletSession(d, { address: account.address, message: edited, signature: await account.signMessage({ message: edited }) })).toMatchObject({ ok: false });
    const late = deps({ now: () => T0 + 301 });
    expect(await issueWalletSession(late, { address: account.address, message: c.message, signature: await account.signMessage({ message: c.message }) })).toMatchObject({ ok: false });
    const sig = await account.signMessage({ message: c.message });
    expect(await issueWalletSession(d, { address: account.address, message: c.message, signature: sig })).toMatchObject({ ok: true });
    expect(await issueWalletSession(d, { address: account.address, message: c.message, signature: sig })).toMatchObject({ ok: false, error: expect.stringMatching(/already used/) });
    const other = deps({ secret: "o".repeat(40) });
    expect(await signIn(other, { message: challengeFor(deps(), account.address)!.message })).toMatchObject({ ok: false });
  });
  it("refuses a signature from another key", async () => {
    const d = deps();
    const c = challengeFor(d, account.address)!;
    const someoneElse = privateKeyToAccount(keccak256(toHex("someone else")));
    expect(await issueWalletSession(d, { address: account.address, message: c.message, signature: await someoneElse.signMessage({ message: c.message }) })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("each chat request", () => {
  it("refuses with every option when nothing is presented", () => {
    const r = authorize(deps(), req());
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (r.ok) return;
    const e = r.body.emerald as Record<string, Record<string, unknown>>;
    expect(e.badge).toMatchObject({ private: true, minTier: 1, scope: emeraldScope(1, Math.floor(T0 / EPOCH)).toString() });
    expect(e.wallet).toMatchObject({ private: false, minHoldWei: parseEther("100000").toString() });
  });
  it("lets badge and wallet sessions through until they expire", () => {
    const d = deps();
    const t = sign(d.secret, { k: "badge", exp: T0 + 60 });
    expect(authorize(d, req({ authorization: `Bearer ${t}` }))).toMatchObject({ ok: true, via: "badge" });
    const wt = sign(d.secret, { k: "wallet", exp: T0 + 60, a: "0xabc" });
    expect(authorize(d, req({ authorization: `Bearer ${wt}` }))).toMatchObject({ ok: true, via: "wallet" });
    expect(authorize(deps({ now: () => T0 + 61 }), req({ authorization: `Bearer ${t}` }))).toMatchObject({ ok: false, status: 401 });
  });
  it("refuses a challenge token or a forged one as a session", () => {
    const d = deps();
    expect(authorize(d, req({ authorization: `Bearer ${sign(d.secret, { k: "challenge", exp: T0 + 60 })}` }))).toMatchObject({ ok: false, status: 401 });
    expect(authorize(d, req({ authorization: `Bearer ${sign("o".repeat(40), { k: "badge", exp: T0 + 60 })}` }))).toMatchObject({ ok: false, status: 401 });
  });
});
