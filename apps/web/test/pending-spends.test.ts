import { hashNullifier } from "@zipnet/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isPendingSpent,
  markPendingSpent,
  PENDING_GRACE_MS,
  prunePendingSpends,
  releaseFailedSpends,
  resetPendingSpendsCache,
  withoutPending,
} from "../src/lib/pending-spends";
import { pickNote } from "../src/lib/wallet";

/** A Storage stand-in: the tests run in node, the wallet in a browser tab */
class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const note = (nullifier: bigint, value: bigint) => ({ nullifier, value, label: 1n, secret: 2n, commitment: 3n, children: 0n, origin: "deposit" as const });
const NOW = 1_800_000_000_000;

describe("pending spends", () => {
  let store: MemStorage;
  beforeEach(() => {
    store = new MemStorage();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = store;
    resetPendingSpendsCache();
  });

  it("a note handed to a courier is never picked again, so the next spend takes another", () => {
    const small = note(11n, 10n);
    const big = note(12n, 50n);
    expect(pickNote([small, big], 5n)).toBe(small);
    markPendingSpent(small.nullifier, { id: "job-1", deadline: 0 }, "http://courier");
    expect(pickNote([small, big], 5n)).toBe(big);
    markPendingSpent(big.nullifier);
    expect(pickNote([small, big], 5n)).toBeNull();
  });

  it("is kept in sessionStorage, keyed by the public nullifier hash, never the secret nullifier", () => {
    markPendingSpent(77n, { id: "j", deadline: 0 }, "http://c");
    const raw = store.getItem("zipnet.pendingSpends")!;
    expect(Object.keys(JSON.parse(raw))).toEqual([hashNullifier(77n).toString()]);
    expect(raw.includes('"77"')).toBe(false);
    // a reload in the same tab (fresh module state) still remembers
    resetPendingSpendsCache();
    expect(isPendingSpent(77n)).toBe(true);
  });

  it("released once the chain shows the spend", () => {
    markPendingSpent(5n, {}, undefined, NOW);
    prunePendingSpends([123n], NOW);
    expect(isPendingSpent(5n, NOW)).toBe(true);
    prunePendingSpends([123n, hashNullifier(5n)], NOW);
    expect(isPendingSpent(5n, NOW)).toBe(false);
  });

  it("released after the timeout: a held job's deadline plus the grace, or the grace alone for one sent now", () => {
    markPendingSpent(1n, { deadline: 0 }, undefined, NOW);
    const deadline = NOW / 1000 + 3600;
    markPendingSpent(2n, { deadline }, undefined, NOW);
    const soon = NOW + PENDING_GRACE_MS + 1;
    expect(withoutPending([note(1n, 1n), note(2n, 1n)], soon).map((n) => n.nullifier)).toEqual([1n]);
    const later = deadline * 1000 + PENDING_GRACE_MS + 1;
    expect(withoutPending([note(1n, 1n), note(2n, 1n)], later)).toHaveLength(2);
    prunePendingSpends([], later);
    resetPendingSpendsCache();
    expect(JSON.parse(store.getItem("zipnet.pendingSpends")!)).toEqual({});
  });

  it("released when its courier job is confirmed failed, kept while it is held or the courier is unreachable", async () => {
    markPendingSpent(1n, { id: "failed-job" }, "http://c");
    markPendingSpent(2n, { id: "held-job" }, "http://c");
    markPendingSpent(3n, { id: "x" }, "http://down");
    const get = (async (url: string) => {
      if (url.startsWith("http://down")) throw new Error("unreachable");
      return new Response(JSON.stringify({ status: url.endsWith("failed-job") ? "failed" : "held" }));
    }) as typeof fetch;
    await releaseFailedSpends(get);
    expect([1n, 2n, 3n].map((n) => isPendingSpent(n))).toEqual([false, true, true]);
  });
});
