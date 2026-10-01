import type { AbiEvent, Address } from "viem";

import type { Chain, RawLog } from "./chain";

/**
 * Keeps the event streams the service needs in memory, synced forward in chunks (public RPCs cap eth_getLogs ranges).
 * Only on-chain facts are kept, and only for the streams the allowlist lets through.
 */
export type Stream = { name: string; address: Address; event: AbiEvent; args?: Record<string, unknown> };

export class Indexer {
  readonly rows = new Map<string, RawLog[]>();
  head = -1n;

  constructor(
    private chain: Chain,
    private streams: Stream[],
    private fromBlock: bigint,
    private chunk = 5_000n,
  ) {
    for (const s of streams) this.rows.set(s.name, []);
  }

  get(name: string): RawLog[] {
    return this.rows.get(name) ?? [];
  }

  async sync(to: bigint) {
    let from = this.head >= 0n ? this.head + 1n : this.fromBlock;
    while (from <= to) {
      const end = from + this.chunk - 1n > to ? to : from + this.chunk - 1n;
      const got = await Promise.all(this.streams.map((s) => this.chain.logs(s.address, s.event, from, end, s.args)));
      got.forEach((logs, i) => this.rows.get(this.streams[i].name)!.push(...logs));
      this.head = end;
      from = end + 1n;
    }
  }
}

/**
 * The first block at or after a unix time, by binary search over block times (cached). Windows only move forward, so
 * the previous answer is a lower bound for the next search.
 */
export class BlockClock {
  private times = new Map<bigint, number>();
  private last = new Map<string, bigint>();

  constructor(private chain: Chain) {}

  async timeOf(block: bigint) {
    if (!this.times.has(block)) {
      if (this.times.size > 20_000) this.times.clear();
      this.times.set(block, await this.chain.blockTime(block));
    }
    return this.times.get(block)!;
  }

  async firstBlockAtOrAfter(name: string, ts: number, lo: bigint, hi: bigint): Promise<bigint> {
    const prev = this.last.get(name);
    if (prev !== undefined && prev > lo && prev <= hi) lo = prev;
    if ((await this.timeOf(hi)) < ts) return hi + 1n;
    if ((await this.timeOf(lo)) >= ts) return this.remember(name, lo);
    // invariant: time(lo) < ts <= time(hi)
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await this.timeOf(mid)) < ts) lo = mid;
      else hi = mid;
    }
    return this.remember(name, hi);
  }

  private remember(name: string, b: bigint) {
    this.last.set(name, b);
    return b;
  }
}
