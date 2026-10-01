"use client";

import clsx from "clsx";
import { formatEther, parseEther } from "viem";

export const zc = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function toWei(s: string): bigint | null {
  try {
    const t = s.trim();
    if (!t || Number(t) <= 0) return null;
    return parseEther(t);
  } catch {
    return null;
  }
}

/**
 * Reverts from the pool that reach us undecoded (the courier has no ABI for them), by selector. They all mean the
 * wallet's view was a moment behind the chain, so trying again fixes them.
 */
const POOL_REVERTS: Record<string, string> = {
  "0xb115d857": "That note was spent a moment ago and the wallet hadn't caught up. Wait a few seconds and try again.", // NullifierAlreadySpent
  "0xa6a78244": "The list of cleared notes changed while this was being proved. Try again.", // IncorrectASPRoot
  "0xfd3d3c4c": "The pool moved on while this was being proved. Try again.", // UnknownStateRoot
};

/** A known pool revert in an error message, as a sentence, or null. */
export function poolRevert(message: string): string | null {
  const sel = message.match(/0x[0-9a-fA-F]{8}\b/)?.[0]?.toLowerCase();
  return (sel && POOL_REVERTS[sel]) || null;
}

/**
 * One line to show for an error. viem puts an undecoded revert's selector on the line after "reverted with the
 * following signature:", so keep it rather than ending the sentence on a colon.
 */
export function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const known = poolRevert(message);
  if (known) return known;
  const [first = "", second] = message.split("\n");
  const line = first.trimEnd().endsWith(":") && second ? `${first.trim()} ${second.trim().split(/\s/)[0]}` : first;
  // A courier flattens viem's details onto one line; the call's addresses and arguments mean nothing to a person
  return line.replace(/\s+(Contract Call|Docs|Details|Version):.*$/, "");
}

/** A courier job that it sent but that reverted on-chain comes back with status "failed": that's not a success. */
export function checkJob<J extends { status: string; tx?: string }>(j: J): J {
  if (j.status === "failed") throw new Error(`The courier sent it, but it failed on-chain${j.tx ? ` (transaction ${j.tx.slice(0, 10)}…)` : ""}. Nothing was spent; try again.`);
  return j;
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-pine">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-[0.8rem] text-lichen">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-frost bg-white/60 px-3 py-2 text-pine placeholder:text-lichen/70 focus:border-pine focus:outline-none";

export function Button({ children, busy, tone = "pine", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; tone?: "pine" | "pad" | "candle" | "quiet" }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        "rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        tone === "pine" && "bg-pine text-snow hover:bg-pine/90",
        tone === "pad" && "bg-pad text-white hover:bg-pad/90",
        tone === "candle" && "bg-candle text-pine hover:bg-candle/90",
        tone === "quiet" && "border border-frost text-pine hover:border-pine",
        rest.className,
      )}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function Hold({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const opts = [
    { sec: 0, label: "Now" },
    { sec: 3600, label: "Within the hour" },
    { sec: 86_400, label: "Any time this epoch" },
  ];
  return (
    <fieldset>
      <legend className="text-sm text-pine">When should the courier send it?</legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {opts.map((o) => (
          <label key={o.sec} className={clsx("cursor-pointer rounded-full border px-3 py-1 text-sm", value === o.sec ? "border-pine bg-pine text-snow" : "border-frost text-pine")}>
            <input type="radio" name="hold" className="sr-only" checked={value === o.sec} onChange={() => onChange(o.sec)} />
            {o.label}
          </label>
        ))}
      </div>
      <p className="mt-1 text-[0.8rem] text-lichen">A random moment later is harder to link to you than right now. The courier signs a promise to deliver.</p>
    </fieldset>
  );
}

export type Outcome = { tone: "ok" | "error"; text: string; link?: string };

export function Result({ out }: { out: Outcome | null }) {
  if (!out) return null;
  return (
    <div role="status" className={clsx("mt-4 rounded-md px-4 py-3 text-sm", out.tone === "ok" ? "bg-pad/10 text-pine" : "bg-candle/15 text-pine")}>
      <p>{out.text}</p>
      {out.link && (
        <p className="mt-2 break-all font-medium">
          <a href={out.link} className="underline underline-offset-2">
            {out.link}
          </a>
        </p>
      )}
    </div>
  );
}
