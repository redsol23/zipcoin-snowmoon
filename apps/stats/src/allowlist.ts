import fs from "node:fs";

import type { Address } from "viem";

/**
 * The allowlist: what the public pages may show. Only entries with `show: true` are ever served, and an entry that is
 * off leaves no trace in any response (not its address, balance, flows or name). Unreleased features stay off until
 * the owner flips them at their launch.
 */

/** Who controls a contract, as a short tag the site turns into a label */
export type Control = "none" | "safe" | "external";

export type Entry = {
  key: string;
  name: string;
  contract: string;
  control: Control;
  role: string;
  controller: string;
  powers: string[];
};

export type Allowlist = { shown: Entry[]; keys: Set<string> };

const CONTROLS = new Set<Control>(["none", "safe", "external"]);

export function parseAllowlist(json: string | unknown): Allowlist {
  const raw = (typeof json === "string" ? JSON.parse(json) : json) as { contracts?: unknown };
  if (!raw || !Array.isArray(raw.contracts)) throw new Error("allowlist: expected { contracts: [...] }");
  const seen = new Set<string>();
  const shown: Entry[] = [];
  for (const c of raw.contracts as Record<string, unknown>[]) {
    const key = c.key;
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`allowlist: bad key ${JSON.stringify(key)}`);
    if (seen.has(key)) throw new Error(`allowlist: ${key} listed twice`);
    seen.add(key);
    if (c.show !== true) continue;
    for (const f of ["name", "contract", "role", "controller"] as const)
      if (typeof c[f] !== "string" || !(c[f] as string).trim()) throw new Error(`allowlist: ${key} is shown but has no ${f}`);
    if (!CONTROLS.has(c.control as Control)) throw new Error(`allowlist: ${key} control must be one of ${[...CONTROLS].join(", ")}`);
    const powers = c.powers ?? [];
    if (!Array.isArray(powers) || powers.some((p) => typeof p !== "string")) throw new Error(`allowlist: ${key} powers must be strings`);
    shown.push({
      key,
      name: c.name as string,
      contract: c.contract as string,
      control: c.control as Control,
      role: c.role as string,
      controller: c.controller as string,
      powers: powers as string[],
    });
  }
  return { shown, keys: new Set(shown.map((e) => e.key)) };
}

export const loadAllowlist = (file: string) => parseAllowlist(fs.readFileSync(file, "utf8"));

/** The address of a shown entry: the deployment's, or for "safe" the one read on-chain. Null when not deployed. */
export function addressOf(key: string, dep: Record<string, unknown>, safe: Address | null): Address | null {
  if (key === "safe") return safe;
  const a = dep[key];
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a) ? (a as Address) : null;
}

/** Every contract address in the deployment, shown or not. Used only to exclude project addresses from counts. */
export function projectAddresses(dep: Record<string, unknown>): Address[] {
  return Object.values(dep).filter((v): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v));
}
