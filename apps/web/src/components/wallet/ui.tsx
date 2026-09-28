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
