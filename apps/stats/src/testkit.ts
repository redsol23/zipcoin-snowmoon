// Test helpers: a fake chain with injected events, reads and balances, and a deployment with every key. Not a test file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Abi, AbiEvent, Address, Hex } from "viem";

import { parseAllowlist } from "./allowlist";
import type { Chain, RawLog } from "./chain";
import type { Probe, ProbeResult } from "./probe";
import { Stats, type StatsConfig } from "./stats";

export const T0 = 1_800_000_000;
/** Block n is mined at T0 + 12n seconds */
export const timeOf = (b: bigint) => T0 + Number(b) * 12;
export const blockAt = (ts: number) => BigInt(Math.floor((ts - T0) / 12));

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** A deployment with every key the deploy script writes, shown or not */
export const KEYS = [
  "zc", "entrypoint", "pool", "semaphore", "broadcaster", "doorstep", "rezip", "addressRegistry", "merchants", "couriers", "pay", "badges",
  "signal", "polls", "batchRelayer", "bands",
] as const;
export const DEP: Record<string, unknown> & { chainId: number; deployBlock: number } = {
  chainId: 1,
  deployBlock: 10,
  scope: "1",
  ...Object.fromEntries(KEYS.map((k, i) => [k, addr(0xc0000 + i)])),
};
export const at = (k: (typeof KEYS)[number]) => DEP[k] as Address;
export const SAFE = addr(0x5afe);

const here = path.dirname(fileURLToPath(import.meta.url));
export const ALLOW = parseAllowlist(fs.readFileSync(path.join(here, "..", "public-contracts.json"), "utf8"));

type Ev = { address: Address; name: string; block: bigint; args: Record<string, unknown> };

const same = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);

export class FakeChain implements Chain {
  tip = 100_000n;
  events: Ev[] = [];
  reads = new Map<string, unknown | ((args: readonly unknown[]) => unknown)>();
  balances = new Map<string, bigint>();
  storage = new Map<string, Hex>();
  calls = { logs: 0, blockTime: 0 };

  emit(address: Address, name: string, block: bigint, args: Record<string, unknown>) {
    this.events.push({ address, name, block, args });
    return this;
  }
  onRead(address: Address, fn: string, v: unknown | ((args: readonly unknown[]) => unknown)) {
    this.reads.set(`${address.toLowerCase()}:${fn}`, v);
    return this;
  }

  async head() {
    return this.tip;
  }
  async blockTime(block: bigint) {
    this.calls.blockTime++;
    return timeOf(block);
  }
  async logs(address: Address, event: AbiEvent, from: bigint, to: bigint, args?: Record<string, unknown>): Promise<RawLog[]> {
    this.calls.logs++;
    return this.events
      .filter((e) => same(e.address, address) && e.name === event.name && e.block >= from && e.block <= to)
      .filter((e) => !args || Object.entries(args).every(([k, v]) => (Array.isArray(v) ? v.some((x) => same(x, e.args[k])) : same(v, e.args[k]))))
      .map((e) => ({ block: e.block, args: e.args }));
  }
  async read(address: Address, _abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const v = this.reads.get(`${address.toLowerCase()}:${functionName}`);
    if (v === undefined) throw new Error(`execution reverted: ${functionName}`);
    return typeof v === "function" ? (v as (a: readonly unknown[]) => unknown)(args) : v;
  }
  async balance(address: Address) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async storageAt(address: Address) {
    return this.storage.get(address.toLowerCase());
  }
}

/** A probe answering from a table of URL -> result */
export const fakeProbe =
  (table: Record<string, Partial<ProbeResult>>): Probe =>
  async (url) => ({ ok: false, ms: 5, error: "unreachable", ...table[url] });

/** Head 100,000: the 24h window starts at block 92,800 and the 7d window at block 49,600 */
export const NOW = timeOf(100_000n);

export function makeStats(chain: FakeChain, over: Partial<StatsConfig> = {}, probes: { probe?: Probe; postman?: Probe } = {}) {
  return new Stats(
    { dep: DEP, allow: ALLOW, epochSec: 3600, exclude: [], funders: [], confirmations: 0n, logChunk: 7_000n, ...over },
    { chain, probe: probes.probe ?? fakeProbe({}), postmanProbe: probes.postman ?? fakeProbe({}), now: () => NOW },
  );
}

export const E = 10n ** 18n;
