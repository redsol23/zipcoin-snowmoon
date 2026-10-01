import { parseEther, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  assignPieces,
  decodeBatchRelay,
  encodeBatchRelay,
  envelopeKeys,
  ENVELOPE_BUCKET,
  openEnvelope,
  pickCouriers,
  planPieces,
  sealEnvelope,
  stateChunk,
  stateDelta,
  countsOf,
  STATE_CHUNK,
  unzipInPieces,
  type CourierInfo,
  type Note,
  type PoolState,
} from "../src";

const zc = (n: number) => parseEther(String(n));
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
const courier = (i: number, stake: bigint, extra: Partial<CourierInfo> = {}): CourierInfo => ({ address: addr(i), stake, endpoint: `http://c${i}`, active: true, ...extra });

describe("courier selection", () => {
  it("skips inactive, unstaked and endpoint-less couriers", () => {
    const list = [courier(1, 0n), courier(2, zc(5), { active: false }), courier(3, zc(5), { endpoint: "" }), courier(4, zc(1))];
    expect(pickCouriers(list, 3).map((c) => c.address)).toEqual([addr(4)]);
  });

  it("draws in proportion to stake", () => {
    const list = [courier(1, zc(1)), courier(2, zc(3))];
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let heavy = 0;
    for (let i = 0; i < 4000; i++) if (pickCouriers(list, 1, rand)[0].address === addr(2)) heavy++;
    expect(heavy / 4000).toBeGreaterThan(0.7);
    expect(heavy / 4000).toBeLessThan(0.8);
  });

  it("returns distinct couriers", () => {
    const list = [courier(1, zc(1)), courier(2, zc(1)), courier(3, zc(1))];
    expect(new Set(pickCouriers(list, 5).map((c) => c.address)).size).toBe(3);
  });
});

describe("sealed envelopes", () => {
  it("round-trips, pads to the bucket and rejects the wrong key", () => {
    const dest = envelopeKeys();
    const msg = new TextEncoder().encode("hello courier");
    const env = sealEnvelope(dest.publicKey, msg);
    // eph 32 + nonce 24 + padded body + tag 16, as hex
    expect((env.length - 2) / 2).toBe(32 + 24 + ENVELOPE_BUCKET + 16);
    expect(new TextDecoder().decode(openEnvelope(dest.privateKey, env)!)).toBe("hello courier");
    expect(openEnvelope(envelopeKeys().privateKey, env)).toBeNull();
  });

  it("derives the same keys from the same seed", () => {
    const seed = new Uint8Array(32).fill(7);
    expect(envelopeKeys(seed).publicKey).toBe(envelopeKeys(seed).publicKey);
  });
});

describe("private reads", () => {
  const state = (n: number): PoolState => ({
    leaves: Array.from({ length: n }, (_, i) => BigInt(i + 1)),
    deposits: [],
    withdrawals: [],
    ragequits: [],
    rezips: [],
    head: BigInt(n),
  });

  it("serves fixed-size chunks", () => {
    const s = state(STATE_CHUNK + 5);
    expect(stateChunk(s, "leaves", 0)).toHaveLength(STATE_CHUNK);
    expect(stateChunk(s, "leaves", 1)).toHaveLength(5);
    expect(() => stateChunk(s, "nope" as never, 0)).toThrow();
  });

  it("serves only the tail after the client's counts, and resets a client that is ahead", () => {
    const s = state(10);
    const d = stateDelta(s, countsOf(state(7)));
    expect(d.tails.leaves).toEqual([8n, 9n, 10n]);
    expect(d.reset).toBeUndefined();
    expect(stateDelta(s, countsOf(state(12))).reset).toBe(true);
  });
});

describe("batch relay data", () => {
  it("round-trips", () => {
    const b = { recipient: addr(9), feeRecipient: addr(8), relayFeeBPS: 100n, batchSize: 2, totalValue: zc(100) };
    expect(decodeBatchRelay(encodeBatchRelay(b))).toEqual(b);
  });
});

describe("denomination pieces", () => {
  it("splits into standard pieces with one remainder", () => {
    expect(planPieces(zc(1337.5))).toEqual([zc(1000), zc(100), zc(100), zc(100), zc(10), zc(10), zc(10), zc(5), zc(1), zc(1), parseEther("0.5")]);
    expect(planPieces(zc(1000)).length).toBe(1);
  });

  it("caps the number of pieces", () => {
    expect(planPieces(zc(99), undefined, 4)).toEqual([zc(50), zc(10), zc(10), zc(29)]);
  });

  it("spreads pieces across notes and runs each note's pieces in order", async () => {
    const note = (v: number, label: bigint) => ({ value: zc(v), label }) as Note;
    const lanes = assignPieces(planPieces(zc(160)), [note(120, 1n), note(60, 2n)])!;
    expect(lanes.flat().reduce((a, s) => a + s.piece, 0n)).toBe(zc(160));
    const order: string[] = [];
    await unzipInPieces(
      lanes,
      async (n, piece) => void order.push(`${n.label}:${piece}`),
      async (spent, piece) => ({ ...spent, value: spent.value - piece }),
    );
    expect(order).toHaveLength(lanes.flat().length);
    expect(assignPieces([zc(500)], [note(100, 1n)])).toBeNull();
  });
});
