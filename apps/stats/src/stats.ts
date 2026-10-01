import { keccak256, toHex, type Address, type Hex } from "viem";

import { addressOf, projectAddresses, type Allowlist } from "./allowlist";
import { ABI, EV, IMPL_SLOT, type Chain, type RawLog } from "./chain";
import { BlockClock, Indexer, type Stream } from "./indexer";
import { privacyReport, type PrivacyReport } from "./privacy";
import type { Probe } from "./probe";

/**
 * The stats service's one job: read the chain (and the postman's and couriers' public /health), and turn it into three
 * cached, read-only JSON documents. Nothing here is per-user: flows are sums, the privacy meter is counts, and the
 * status page is about the project's own services.
 */

export type StatsConfig = {
  /** Parsed deployment JSON (contracts/deployments/<name>.json) */
  dep: Record<string, unknown> & { chainId: number; deployBlock: number };
  allow: Allowlist;
  /** Overrides the on-chain lookup of the treasury Safe */
  safe?: Address;
  postmanUrl?: string;
  /** Fallback when the postman doesn't say its epoch length */
  epochSec: number;
  /** Operator-kept addresses that are the project's own (Veridia's wallets, couriers' cover wallets). Never served. */
  exclude: Address[];
  /** Wallets that fund project wallets: anything they sent ZC to counts as the project's too (e.g. Veridia's treasury) */
  funders: Address[];
  confirmations: bigint;
  logChunk: bigint;
};

export type Deps = { chain: Chain; probe: Probe; postmanProbe: Probe; now: () => number };

const WINDOWS = [
  ["24h", 86_400],
  ["7d", 7 * 86_400],
] as const;
export type WindowName = "24h" | "7d" | "all";
type Windows = Record<WindowName, bigint>;

const OWNER_ROLE = keccak256(toHex("OWNER_ROLE"));
const POSTMAN_ROLE = keccak256(toHex("ASP_POSTMAN"));
const ZERO = /^0x0{40}$/i;

const str = (v: bigint) => v.toString();
const big = (v: unknown) => (typeof v === "bigint" ? v : 0n);
const lower = (a: string) => a.toLowerCase();

export class Stats {
  private indexer: Indexer;
  private clock: BlockClock;
  private safe: Address | null | undefined;
  private shown: Record<string, Address | null> = {};
  ledger: unknown = null;
  privacy: PrivacyReport | null = null;
  status: unknown = null;
  updatedAt = 0;
  lastError: string | null = null;

  constructor(
    private cfg: StatsConfig,
    private deps: Deps,
  ) {
    const on = (k: string) => cfg.allow.keys.has(k) && !!addressOf(k, cfg.dep, null);
    const at = (k: string) => addressOf(k, cfg.dep, null)!;
    const s: Stream[] = [];
    if (on("pool")) {
      s.push({ name: "deposits", address: at("pool"), event: EV.poolDeposited });
      s.push({ name: "withdrawals", address: at("pool"), event: EV.poolWithdrawn });
      s.push({ name: "ragequits", address: at("pool"), event: EV.poolRagequit });
      s.push({ name: "harvests", address: at("pool"), event: EV.poolHarvested });
    }
    if (on("pay")) {
      s.push({ name: "taxSplit", address: at("pay"), event: EV.taxSplit });
    }
    if (on("bands")) {
      s.push({ name: "bandsDeposited", address: at("bands"), event: EV.bandsDeposited });
      s.push({ name: "bandsFees", address: at("bands"), event: EV.bandsFees });
      s.push({ name: "bandsEthToSafe", address: at("bands"), event: EV.bandsEthToSafe });
      s.push({ name: "bandsForwarded", address: at("bands"), event: EV.bandsForwarded });
      s.push({ name: "bandsWithdrawn", address: at("bands"), event: EV.bandsWithdrawn });
    }
    // Couriers are listed for the status page and are always excluded from the privacy meter's outside depositors
    if (addressOf("couriers", cfg.dep, null)) {
      s.push({ name: "bonded", address: at("couriers"), event: EV.bonded });
      s.push({ name: "endpointSet", address: at("couriers"), event: EV.endpointSet });
    }
    if (addressOf("entrypoint", cfg.dep, null)) {
      s.push({ name: "roots", address: at("entrypoint"), event: EV.rootUpdated });
      s.push({ name: "roleGranted", address: at("entrypoint"), event: EV.roleGranted });
      s.push({ name: "roleRevoked", address: at("entrypoint"), event: EV.roleRevoked });
    }
    if (cfg.funders.length && addressOf("zc", cfg.dep, null)) s.push({ name: "funded", address: at("zc"), event: EV.transfer, args: { from: cfg.funders } });
    this.indexer = new Indexer(deps.chain, s, BigInt(cfg.dep.deployBlock), cfg.logChunk);
    this.clock = new BlockClock(deps.chain);
  }

  /** One refresh: sync events to the (confirmed) head, then rebuild all three documents. */
  async refresh() {
    const { chain } = this.deps;
    const tip = await chain.head();
    const head = tip > this.cfg.confirmations ? tip - this.cfg.confirmations : tip;
    await this.indexer.sync(head);
    const now = this.deps.now();
    const from = BigInt(this.cfg.dep.deployBlock);
    const windows: Windows = { all: from, "24h": from, "7d": from };
    for (const [name, sec] of WINDOWS) windows[name] = await this.clock.firstBlockAtOrAfter(name, now - sec, from, head);
    // A window that reaches back past the deployment starts at the deployment
    const born = await this.clock.timeOf(from);
    const since = { "24h": Math.max(born, now - 86_400), "7d": Math.max(born, now - 7 * 86_400), all: born };
    await this.resolveSafe();

    const [ledger, status] = await Promise.all([this.buildLedger(head, windows, since, now), this.buildStatus(head, now)]);
    this.ledger = ledger;
    this.status = status;
    this.privacy = privacyReport({
      deposits: this.indexer.get("deposits"),
      withdrawals: this.indexer.get("withdrawals").length,
      ragequits: this.indexer.get("ragequits").length,
      windows,
      since,
      excluded: this.excluded(),
      poolShown: this.cfg.allow.keys.has("pool"),
      head,
      now,
      chainId: this.cfg.dep.chainId,
    });
    this.updatedAt = now;
    this.lastError = null;
  }

  // ------------------------------------------------------------------------------------------------ addresses

  private async resolveSafe() {
    if (this.safe !== undefined) return;
    const { chain } = this.deps;
    let safe: Address | null = this.cfg.safe ?? null;
    const bands = addressOf("bands", this.cfg.dep, null);
    const pay = addressOf("pay", this.cfg.dep, null);
    try {
      if (!safe && bands) safe = (await chain.read(bands, ABI.bands, "SAFE")) as Address;
      if (!safe && pay) safe = (await chain.read(pay, ABI.treasuryOf, "TREASURY")) as Address;
    } catch {
      return; // try again next refresh
    }
    this.safe = safe && !ZERO.test(safe) ? safe : null;
    for (const e of this.cfg.allow.shown) this.shown[e.key] = addressOf(e.key, this.cfg.dep, this.safe);
  }

  /** Holders of an Entrypoint role, from its RoleGranted / RoleRevoked history */
  private roleHolders(role: Hex): Address[] {
    const ev: { block: bigint; granted: boolean; account: Address }[] = [];
    for (const l of this.indexer.get("roleGranted")) if (l.args.role === role) ev.push({ block: l.block, granted: true, account: l.args.account as Address });
    for (const l of this.indexer.get("roleRevoked")) if (l.args.role === role) ev.push({ block: l.block, granted: false, account: l.args.account as Address });
    const held = new Map<string, Address>();
    // Within a block, a grant and a revoke of the same account can't be ordered by block alone; grants go first,
    // which matches how a handover is written (grant the new owner, then renounce).
    ev.sort((a, b) => (a.block === b.block ? Number(b.granted) - Number(a.granted) : a.block < b.block ? -1 : 1));
    for (const e of ev) e.granted ? held.set(lower(e.account), e.account) : held.delete(lower(e.account));
    return [...held.values()];
  }

  /** Addresses the privacy meter doesn't count as outside depositors. Only their counts are ever served. */
  private excluded() {
    const contracts = new Set(projectAddresses(this.cfg.dep).map(lower));
    const safes = new Set<string>([...(this.safe ? [lower(this.safe)] : []), ...this.roleHolders(OWNER_ROLE).map(lower), ...this.roleHolders(POSTMAN_ROLE).map(lower)]);
    const couriers = new Set([...this.indexer.get("bonded"), ...this.indexer.get("endpointSet")].map((l) => lower(l.args.courier as string)));
    const listed = new Set(this.cfg.exclude.map(lower));
    const funded = new Set([...this.cfg.funders.map(lower), ...this.indexer.get("funded").map((l) => lower(l.args.to as string))]);
    const all = new Set([...contracts, ...safes, ...couriers, ...listed, ...funded]);
    return {
      set: all,
      counts: { projectContracts: contracts.size, safesAndKeys: safes.size, couriers: couriers.size, listed: listed.size, fundedByProject: funded.size, total: all.size },
    };
  }

  // ------------------------------------------------------------------------------------------------ ledger

  private async balances(key: string, a: Address) {
    const { chain } = this.deps;
    const zc = addressOf("zc", this.cfg.dep, null);
    const safely = async <T>(p: Promise<T>) => {
      try {
        return await p;
      } catch {
        return null;
      }
    };
    const [eth, zcBal, pending] = await Promise.all([
      safely(chain.balance(a)),
      zc && key !== "zc" ? safely(chain.read(zc, ABI.erc20, "balanceOf", [a]) as Promise<bigint>) : Promise.resolve(null),
      zc && key !== "zc" ? safely(chain.read(zc, ABI.zcRewards, "pendingReward", [a]) as Promise<bigint>) : Promise.resolve(null),
    ]);
    return { eth: eth === null ? null : str(eth), zc: zcBal === null ? null : str(zcBal), zcRewardsPending: pending === null ? null : str(pending) };
  }

  /** Live facts about who controls a contract, read from the chain rather than taken on trust */
  private async live(key: string, a: Address): Promise<Record<string, unknown> | undefined> {
    const { chain } = this.deps;
    try {
      if (key === "safe") {
        const read = await Promise.all([chain.read(a, ABI.safe, "getThreshold"), chain.read(a, ABI.safe, "getOwners")]).catch(() => null);
        // Say so plainly if the treasury address isn't a Safe at all (a test chain's plain key, or a mistake)
        if (!read) return { isSafe: false };
        const [threshold, owners] = read;
        // The signers' count, not their addresses: those are people's keys
        return { isSafe: true, threshold: Number(threshold as bigint), signers: (owners as Address[]).length };
      }
      if (key === "entrypoint") {
        const slot = await chain.storageAt(a, IMPL_SLOT);
        const impl = slot && slot.length >= 42 ? (`0x${slot.slice(-40)}` as Address) : null;
        const label = (x: Address) => (this.safe && lower(x) === lower(this.safe) ? "treasury Safe" : null);
        return {
          upgradeable: true,
          implementation: impl && !ZERO.test(impl) ? impl : null,
          owners: this.roleHolders(OWNER_ROLE).map((x) => ({ address: x, is: label(x) })),
          postman: this.roleHolders(POSTMAN_ROLE),
        };
      }
      if (key === "bands") {
        const [safe, paused] = await Promise.all([chain.read(a, ABI.bands, "SAFE"), chain.read(a, ABI.bands, "paused")]);
        return { safe, paused };
      }
      if (key === "pay") {
        const [tax, burn, couriers] = await Promise.all([chain.read(a, ABI.pay, "TAX_BPS"), chain.read(a, ABI.pay, "BURN_SHARE_BPS"), chain.read(a, ABI.pay, "COURIER_SHARE_BPS")]);
        const t = Number(tax as bigint);
        const b = Number(burn as bigint);
        const c = Number(couriers as bigint);
        return { taxBps: t, split: { burnBps: b, couriersBps: c, treasuryBps: 10_000 - b - c }, treasury: await chain.read(a, ABI.treasuryOf, "TREASURY") };
      }
      if (key === "pool") return { treasury: await chain.read(a, ABI.treasuryOf, "TREASURY") };
    } catch {
      return { error: "unreadable" };
    }
    return undefined;
  }

  private sumWindows(rows: RawLog[], windows: Windows, fields: Record<string, string>) {
    const out = {} as Record<WindowName, Record<string, string | number>>;
    for (const w of ["24h", "7d", "all"] as WindowName[]) {
      const sums: Record<string, bigint> = Object.fromEntries(Object.keys(fields).map((k) => [k, 0n]));
      let count = 0;
      for (const r of rows) {
        if (r.block < windows[w]) continue;
        count++;
        for (const [k, arg] of Object.entries(fields)) sums[k] += big(r.args[arg]);
      }
      out[w] = { count, ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, str(v)])) };
    }
    return out;
  }

  private async buildLedger(head: bigint, windows: Windows, since: Record<WindowName, number>, now: number) {
    const on = (k: string) => this.cfg.allow.keys.has(k) && !!this.shown[k];
    const contracts = await Promise.all(
      this.cfg.allow.shown.map(async (e) => {
        const a = this.shown[e.key] ?? null;
        return {
          key: e.key,
          name: e.name,
          contract: e.contract,
          control: e.control,
          role: e.role,
          controller: e.controller,
          powers: e.powers,
          address: a,
          deployed: !!a,
          ...(a ? { balances: await this.balances(e.key, a), live: await this.live(e.key, a) } : {}),
        };
      }),
    );

    const g = (n: string) => this.indexer.get(n);
    const flows: Record<string, unknown> = {};
    if (on("pay")) flows.salesTax = this.sumWindows(g("taxSplit"), windows, { burned: "burned", couriers: "toCouriers", treasury: "toTreasury" });
    if (on("bands")) {
      flows.bands = {
        // ZC only, above the launch range only; ETH is never deposited: it is forwarded to the Safe (ethToSafe)
        deposited: this.sumWindows(g("bandsDeposited"), windows, { zc: "zcIn" }),
        feesToSafe: this.sumWindows(g("bandsFees"), windows, { eth: "eth", zc: "zc" }),
        ethToSafe: this.sumWindows(g("bandsEthToSafe"), windows, { eth: "eth" }),
        forwardedToSafe: this.sumWindows(g("bandsForwarded"), windows, { zc: "zc", eth: "eth" }),
        withdrawnToSafe: this.sumWindows(g("bandsWithdrawn"), windows, { eth: "eth", zc: "zc" }),
      };
    }
    if (on("pool")) flows.poolHarvests = this.sumWindows(g("harvests"), windows, { claimed: "claimed", forwarded: "forwarded" });

    return {
      ok: true,
      updatedAt: now,
      chainId: this.cfg.dep.chainId,
      block: str(head),
      units: "Amounts are strings in wei: ZC and ETH both have 18 decimals.",
      windows: Object.fromEntries((["24h", "7d", "all"] as WindowName[]).map((w) => [w, { fromBlock: str(windows[w]), since: since[w] }])),
      contracts,
      flows,
      notes: [
        "Only contracts on the public allowlist are listed.",
        "Flows are sums of on-chain events in each window.",
        "Not investment advice.",
      ],
    };
  }

  // ------------------------------------------------------------------------------------------------ status

  private async buildStatus(head: bigint, now: number) {
    const { chain, probe, postmanProbe } = this.deps;
    const roots = this.indexer.get("roots");
    const last = roots.at(-1);
    let postman: Record<string, unknown> = { configured: !!this.cfg.postmanUrl, address: this.roleHolders(POSTMAN_ROLE)[0] ?? null };
    let epochSec = this.cfg.epochSec;
    if (this.cfg.postmanUrl) {
      const base = this.cfg.postmanUrl.replace(/\/$/, "");
      const [h, asp] = await Promise.all([postmanProbe(`${base}/health`), postmanProbe(`${base}/asp`)]);
      const body = (h.body ?? {}) as Record<string, unknown>;
      const e = Number((asp.body as Record<string, unknown> | undefined)?.epochSec);
      if (Number.isFinite(e) && e > 0) epochSec = e;
      postman = { ...postman, reachable: h.ok, latencyMs: h.ms, ...(h.ok ? { approved: num(body.approved), rejected: num(body.rejected), heldByCaps: num(body.heldByCaps) } : { error: h.error ?? "unreachable" }) };
    }
    const at = last ? Number(big(last.args._timestamp)) : null;
    postman.lastRoot = at ? { at, ageSec: Math.max(0, now - at), epoch: Math.floor(at / epochSec), epochSec, published: roots.length } : null;

    const couriersAddr = addressOf("couriers", this.cfg.dep, null);
    const couriers: Record<string, unknown>[] = [];
    if (couriersAddr && this.cfg.allow.keys.has("couriers")) {
      const seen = [...new Set([...this.indexer.get("bonded"), ...this.indexer.get("endpointSet")].map((l) => l.args.courier as Address))].slice(0, 100);
      const rows = await Promise.all(
        seen.map(async (c) => {
          try {
            const [info, active] = await Promise.all([
              chain.read(couriersAddr, ABI.couriers, "couriers", [c]) as Promise<readonly [bigint, bigint, string]>,
              chain.read(couriersAddr, ABI.couriers, "isActive", [c]) as Promise<boolean>,
            ]);
            return { address: c, bond: info[0], unbondAt: Number(info[1]), endpoint: info[2], active };
          } catch {
            return null;
          }
        }),
      );
      const bonded = rows.filter((r): r is NonNullable<typeof r> => !!r && r.bond > 0n);
      const probed = await Promise.all(bonded.map((r) => (r.active ? probe(`${r.endpoint.replace(/\/$/, "")}/health`) : Promise.resolve(null))));
      bonded.forEach((r, i) => {
        const p = probed[i];
        const body = (p?.body ?? {}) as Record<string, unknown>;
        const lastJobAt = num(body.lastJobAt);
        couriers.push({
          address: r.address,
          endpoint: r.endpoint,
          bond: str(r.bond),
          active: r.active,
          unbonding: r.unbondAt > 0,
          reachable: p ? p.ok : null,
          latencyMs: p ? p.ms : null,
          ...(p && !p.ok ? { error: p.error ?? "unreachable" } : {}),
          version: p?.ok && typeof body.version === "string" ? body.version.slice(0, 40) : null,
          lastJobAgeSec: p?.ok && lastJobAt ? Math.max(0, now - lastJobAt) : null,
        });
      });
      couriers.sort((a, b) => (BigInt(b.bond as string) > BigInt(a.bond as string) ? 1 : -1));
    }
    return { ok: true, updatedAt: now, chainId: this.cfg.dep.chainId, block: str(head), postman, couriers };
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
