"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { BEHIND, CITIES, footnote, tone, type Resident, type WorldEvent } from "@/lib/veridia";

import { Portrait } from "./Portrait";

/** Subscribes to the story. `who` narrows it to one resident. */
export function useStory(who?: string) {
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "down">("connecting");
  useEffect(() => {
    const es = new EventSource(`/api/feed/stream${who ? `?who=${who}` : ""}`);
    es.addEventListener("event", (m) => setEvents((prev) => [JSON.parse((m as MessageEvent).data) as WorldEvent, ...prev].slice(0, 300)));
    es.addEventListener("ping", () => setStatus("live"));
    es.addEventListener("down", () => setStatus("down"));
    es.onerror = () => setStatus("down");
    return () => es.close();
  }, [who]);
  return { events, status };
}

const TONE_DOT = { pad: "bg-pad", candle: "bg-candle", slate: "bg-slate" } as const;

function Paragraph({ e, residents }: { e: WorldEvent; residents: Map<string, Resident> }) {
  const r = residents.get(e.who);
  const note = footnote(e);
  const t = tone(e.action);
  // Roughly when it happened, as the story tells it; never the exact time
  const time = e.when ? e.when[0].toUpperCase() + e.when.slice(1) : "Just now";
  return (
    <article className="relative grid grid-cols-[2.25rem_1fr] gap-x-3 py-3">
      <div className="pt-1.5">
        {t ? <span className={clsx("block h-3 w-3 rounded-full", TONE_DOT[t])} title={e.action} /> : <span className="block h-3 w-3 rounded-full border border-frost" />}
      </div>
      <div>
        <p className="font-story text-[1.19rem] leading-[1.6] text-pine">{e.line}</p>
        <p className="mt-1 text-[0.82rem] leading-snug text-lichen">
          <span>{time}</span>
          {r && (
            <>
              {", "}
              <Link href={`/resident/${r.id}`} className="underline decoration-frost underline-offset-2 hover:decoration-pine">
                {r.name}
              </Link>
            </>
          )}
          {note && <>. {note}</>}
        </p>
      </div>
    </article>
  );
}

export function Chapter({ residents, who }: { residents: Resident[]; who?: string }) {
  const { events, status } = useStory(who);
  const byId = useMemo(() => new Map(residents.map((r) => [r.id, r])), [residents]);
  const shown = events.filter((e) => e.action !== "rest" || events.length < 8).slice(0, 80);
  return (
    <section aria-live="polite" aria-busy={status === "connecting"}>
      {status === "down" && (
        <p className="mb-4 rounded-md bg-drift px-4 py-3 text-sm text-pine">
          The story service isn&apos;t answering. Start it with <code className="font-sans">./scripts/local-services.sh</code>, then this page reconnects by itself.
        </p>
      )}
      {shown.length === 0 && status !== "down" && (
        <p className="font-story text-lg italic text-lichen">The residents are up and about. The story catches up with them a little later…</p>
      )}
      <div className="divide-y divide-frost/70">
        {shown.map((e, i) => (
          <Paragraph key={`${e.at}-${e.who}-${i}`} e={e} residents={byId} />
        ))}
      </div>
      {shown.length > 0 && <p className="mt-4 text-[0.82rem] text-lichen">{BEHIND}</p>}
    </section>
  );
}

/** The drawn map: four places, residents as circles that light up for a few seconds when they act. */
export function CityMap({ residents }: { residents: Resident[] }) {
  const { events } = useStory();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const last = new Map<string, WorldEvent>();
  for (const e of [...events].reverse()) last.set(e.who, e);

  const placed = residents.map((r, i) => {
    const c = CITIES[r.city] ?? CITIES.Meldan;
    const k = residents.filter((x, j) => x.city === r.city && j < i).length;
    const a = k * 2.2 + (r.shop ? 1 : 0);
    return { r, x: c.x + Math.cos(a) * (16 + k * 5), y: c.y + Math.sin(a) * (14 + k * 4) };
  });

  return (
    <figure className="select-none">
      <svg viewBox="0 0 400 300" className="h-auto w-full" role="img" aria-label="Map of Veridia and its neighbors, with residents">
        {/* the Kalimar forest south of Meldan */}
        {Array.from({ length: 22 }, (_, i) => {
          const x = 150 + ((i * 37) % 80);
          const y = 172 + ((i * 23) % 36);
          return <path key={i} d={`M${x} ${y}l5 -11l5 11z`} fill="#C9D3CB" />;
        })}
        {/* the mountain with the archive node inside */}
        <path d="M175 60l32 -44l32 44z" fill="#E1E7E2" stroke="#C9D3CB" strokeWidth="1.5" />
        <text x="207" y="76" textAnchor="middle" className="fill-lichen font-story" fontSize="10" fontStyle="italic">archive node</text>
        {/* roads */}
        <path d="M120 120 C170 95 230 80 290 82 M290 82 C320 110 335 150 345 178 M120 120 C150 170 200 210 250 230 M250 230 C300 215 330 200 345 178 M120 120 C100 170 85 205 70 235 M70 235 C130 250 190 245 250 230" fill="none" stroke="#C9D3CB" strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" />
        {Object.entries(CITIES).map(([name, c]) => (
          <g key={name}>
            <circle cx={c.x} cy={c.y} r="28" fill="#E1E7E2" stroke="#C9D3CB" strokeWidth="1" />
            <text x={c.x} y={c.y + 44} textAnchor="middle" className="fill-lichen font-story" fontSize="12" fontStyle="italic">
              {name}
            </text>
          </g>
        ))}
        {placed.map(({ r, x, y }) => {
          const e = last.get(r.id);
          const fresh = e && now - e.at < 8000 && e.action !== "rest";
          const t = e ? tone(e.action) : null;
          const fill = fresh && t ? { pad: "#22A866", candle: "#D6A01E", slate: "#496789" }[t] : "#18241F";
          return (
            <Link key={r.id} href={`/resident/${r.id}`}>
              <title>{`${r.name}${e ? `: ${e.line}` : ""}`}</title>
              {fresh && <circle cx={x} cy={y} r="9" fill={fill} opacity="0.22" className="motion-safe:animate-ping [transform-box:fill-box] [transform-origin:center]" />}
              <circle cx={x} cy={y} r={r.shop ? 5 : 4} fill={fill} stroke="#ECF0EC" strokeWidth="1.5" />
            </Link>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-[0.82rem] text-lichen">
        A circle lights up when the story reaches someone: green for private payments, gold for coins burned to be heard, slate for anonymous posts and polls. {BEHIND}
      </figcaption>
    </figure>
  );
}

export function Residents({ residents }: { residents: Resident[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {residents.map((r) => (
        <li key={r.id}>
          <Link href={`/resident/${r.id}`} className="group flex items-center gap-3 rounded-md py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine">
            <Portrait seed={r.id} shop={!!r.shop} size="sm" />
            <span>
              <span className="font-story text-base text-pine group-hover:underline">{r.name}</span>
              <span className="block text-[0.8rem] text-lichen">{r.shop ? "shop" : "resident"} in {r.city}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
