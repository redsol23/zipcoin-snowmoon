import { parseAbiItem, type Address, type PublicClient } from "viem";

import { zipCouriersAbi } from "./abi";
import { envelopeKeys, openEnvelope, sealEnvelope } from "./crypto";
import { toJson } from "./json";

/**
 * Courier discovery. Couriers bond ZC in ZipCouriers and publish an endpoint; clients choose among the active ones,
 * weighted by stake, so no single team-run relayer sees everyone's traffic and a courier with more at risk carries
 * proportionally more.
 */

export type CourierInfo = { address: Address; stake: bigint; endpoint: string; active: boolean };

const bonded = parseAbiItem("event Bonded(address indexed courier, uint256 stake, string endpoint)");
const endpointSet = parseAbiItem("event EndpointSet(address indexed courier, string endpoint)");

/** Every courier that ever bonded, with its current stake, endpoint and whether it is active. */
export async function listCouriers(client: PublicClient, registry: Address, fromBlock = 0n): Promise<CourierInfo[]> {
  const [b, e] = await Promise.all([
    client.getLogs({ address: registry, event: bonded, fromBlock }),
    client.getLogs({ address: registry, event: endpointSet, fromBlock }),
  ]);
  const addrs = [...new Set([...b, ...e].map((l) => l.args.courier!.toLowerCase()))] as Address[];
  return Promise.all(
    addrs.map(async (address) => {
      const [c, active] = await Promise.all([
        client.readContract({ address: registry, abi: zipCouriersAbi, functionName: "couriers", args: [address] }) as Promise<readonly [bigint, bigint, string]>,
        client.readContract({ address: registry, abi: zipCouriersAbi, functionName: "isActive", args: [address] }) as Promise<boolean>,
      ]);
      return { address, stake: c[0], endpoint: c[2], active };
    }),
  );
}

const usable = (list: CourierInfo[]) => list.filter((c) => c.active && c.stake > 0n && /^https?:\/\//.test(c.endpoint));

/** One courier, chosen with probability proportional to stake. `rand` in [0, 1). */
export function pickCourier(list: CourierInfo[], rand: () => number = Math.random): CourierInfo | null {
  return pickCouriers(list, 1, rand)[0] ?? null;
}

/** Up to `n` distinct couriers, each draw weighted by stake among those not yet drawn. */
export function pickCouriers(list: CourierInfo[], n: number, rand: () => number = Math.random): CourierInfo[] {
  const pool = usable(list);
  const out: CourierInfo[] = [];
  while (out.length < n && pool.length > 0) {
    const total = pool.reduce((a, c) => a + c.stake, 0n);
    // Scale the draw to 1e18 so large stakes keep their precision as bigints
    let r = (BigInt(Math.floor(rand() * 1e18)) * total) / 10n ** 18n;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      if (r < pool[i].stake) break;
      r -= pool[i].stake;
    }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * Two-hop sealed submission: seal a job to `dest` (a courier's `encryptionKey` from its /quote) and hand it to a
 * different courier, `firstHop`, which forwards it without being able to read it. The reply is sealed to a one-time
 * key made here, so only this caller can read it. `job` is exactly what POST /jobs takes.
 */
export async function sendSealed(firstHop: string, dest: { url: string; encryptionKey: `0x${string}` }, job: Record<string, unknown>) {
  const reply = envelopeKeys();
  const inner = new TextEncoder().encode(JSON.stringify({ job: toJson(job), replyKey: reply.publicKey }));
  const res = await fetch(`${firstHop.replace(/\/$/, "")}/relay-hop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: dest.url, envelope: sealEnvelope(dest.encryptionKey, inner) }),
  });
  const body = (await res.json()) as { reply?: `0x${string}`; error?: string };
  if (!res.ok || !body.reply) throw new Error(body.error ?? `first hop answered ${res.status}`);
  const opened = openEnvelope(reply.privateKey, body.reply);
  if (!opened) throw new Error("the reply wasn't sealed to us");
  const r = JSON.parse(new TextDecoder().decode(opened)) as { ok: boolean; job?: { id: string; status: string; tx?: string; deadline: number }; error?: string };
  if (!r.ok) throw new Error(r.error ?? "the destination courier refused the job");
  return r.job!;
}
