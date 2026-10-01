import { fromJson, listCouriers, openEnvelope, sealEnvelope, toJson, type SolidityProof } from "@zipnet/sdk";
import type { Hex } from "viem";

import { cfg, envelope, pub } from "./config";
import { accept, Reject, type Kind } from "./jobs";
import { isPayoutKind, PayoutArgError, payoutArgs } from "./payouts";

/**
 * Two-hop sealed submission.
 *
 * A client seals its job to a destination courier's envelope key and hands the envelope to a different courier, the
 * first hop. The first hop sees the client's IP but only an opaque, size-padded envelope; the destination sees the
 * job but only the first hop's IP. The reply is sealed to a one-time key inside the envelope, so the first hop can't
 * read that either. First hops only forward to couriers bonded in ZipCouriers, so this can't be used to reach
 * arbitrary hosts.
 */

type SemProof = { merkleTreeDepth: string; merkleTreeRoot: string; nullifier: string; message: string; scope: string; points: string[] };
const semProof = (p: SemProof) => ({
  merkleTreeDepth: BigInt(p.merkleTreeDepth),
  merkleTreeRoot: BigInt(p.merkleTreeRoot),
  nullifier: BigInt(p.nullifier),
  message: BigInt(p.message),
  scope: BigInt(p.scope),
  points: p.points.map((x) => BigInt(x)),
});

/** Posts, votes and unlocks arrive as JSON; give viem the exact types of ZipSignal.post / ZipPolls.vote / ZipBadges.unlock. */
export function semaphoreArgs(kind: Kind, a?: unknown[]) {
  // Parked-payout recovery (payouts.ts): checked strictly, and a bad argument is the client's error
  if (isPayoutKind(kind)) {
    try {
      return payoutArgs(kind, a);
    } catch (e) {
      throw e instanceof PayoutArgError ? new Reject(e.message) : e;
    }
  }
  if (!a) return a;
  if (kind === "post") return [BigInt(a[0] as string), BigInt(a[1] as string), String(a[2]), semProof(a[3] as SemProof)];
  if (kind === "vote") return [BigInt(a[0] as string), Number(a[1]), a[2], semProof(a[3] as SemProof)];
  if (kind === "unlock") return [BigInt(a[0] as string), (a[1] as string[][]).map((g) => g.map((x) => BigInt(x)))];
  return a;
}

export type JobBody = { kind: Kind; withdrawal?: never; proof?: SolidityProof<8>; proofs?: SolidityProof<8>[]; args?: unknown[]; holdSec?: number };

export const parseJob = (text: string) => fromJson<JobBody>(text, ["pA", "pB", "pC", "pubSignals"]);

/** Accepts a parsed job body; shared by POST /jobs and sealed envelopes. `client` keys the per-client free-job limit. */
export async function acceptBody(b: JobBody, client: string | null = null) {
  const j = await accept(
    { kind: b.kind, withdrawal: b.withdrawal, proof: b.proof, proofs: b.proofs, args: semaphoreArgs(b.kind, b.args) },
    Math.max(0, Number(b.holdSec ?? 0)),
    false,
    client,
  );
  return { id: j.id, status: j.status, tx: j.tx, submitAt: j.submitAt, deadline: j.deadline, receipt: j.receipt };
}

// ---------------------------------------------------------------------------------------------------------------
// destination: POST /sealed
// ---------------------------------------------------------------------------------------------------------------

export async function openSealed(body: { envelope: Hex }, firstHop: string | null = null) {
  const plain = openEnvelope(envelope.privateKey, body.envelope);
  if (!plain) throw new Reject("envelope isn't for this courier");
  const { job, replyKey } = JSON.parse(new TextDecoder().decode(plain)) as { job: string; replyKey: Hex };
  let result: unknown;
  try {
    result = { ok: true, job: await acceptBody(parseJob(job), firstHop) };
  } catch (e) {
    result = { ok: false, error: (e as Error).message.split("\n")[0] };
  }
  // Same status either way: the first hop learns nothing from the response
  return { reply: sealEnvelope(replyKey, new TextEncoder().encode(toJson(result))) };
}

// ---------------------------------------------------------------------------------------------------------------
// first hop: POST /relay-hop
// ---------------------------------------------------------------------------------------------------------------

let known: { at: number; endpoints: Set<string> } = { at: 0, endpoints: new Set() };
const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();

async function bondedEndpoints() {
  if (Date.now() - known.at > 60_000) {
    const list = await listCouriers(pub, cfg.dep.couriers, BigInt(cfg.dep.deployBlock));
    known = { at: Date.now(), endpoints: new Set(list.filter((c) => c.active).map((c) => norm(c.endpoint))) };
  }
  return known.endpoints;
}

const hops = new Map<string, number[]>();

export async function relayHop(body: { to: string; envelope: Hex }, ip: string) {
  const now = Date.now();
  const recent = (hops.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= cfg.hopsPerMinute) throw new Reject("slow down");
  hops.set(ip, [...recent, now]);

  const to = norm(String(body.to ?? ""));
  if (to === norm(cfg.publicUrl)) throw new Reject("the second hop must be a different courier");
  if (!(await bondedEndpoints()).has(to)) throw new Reject("destination isn't a bonded courier");
  if (!/^0x[0-9a-f]+$/i.test(body.envelope ?? "") || body.envelope.length > 300_000) throw new Reject("bad envelope");

  const res = await fetch(`${to}/sealed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: body.envelope }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Reject(`destination courier answered ${res.status}`);
  return (await res.json()) as { reply: Hex };
}
