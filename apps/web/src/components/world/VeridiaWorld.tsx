"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { tone, type Resident, type WorldEvent } from "@/lib/veridia";

import { useStory } from "../World";

import { H, homeOf, LANDMARKS, paintStatic, W, type Pt } from "./scene";
import { OFFLINE_CAST, ScriptedDay } from "./scripted";
import { COURIER_NOTE, Veridia, type Hit } from "./sim";
import { skyAt } from "./sky";

/**
 * Veridia, alive. A painted world (drawn once) under a living layer (every frame): residents walking to the places
 * they like and to shops and doors, couriers carrying sealed proofs, lights where payments and burns happen, notes on
 * the board, neighbours gathering for polls, weather, and night following the viewer's clock. Driven by the public
 * story feed; when the story service is offline it plays a scripted day instead, and says so.
 *
 * Drag to look around, pinch or use the buttons to zoom, hover or tap anyone (or any place) to see who they are and
 * what they just did. With reduced motion the world is drawn still and updates only when something happens. The
 * loop stops while the tab is hidden or the map is scrolled out of view.
 */
export function VeridiaWorld({
  residents,
  focus,
  className,
  label = "A living map of Veridia",
}: {
  residents: Resident[];
  /** Resident id to center and zoom on (a resident's own page) */
  focus?: string;
  className?: string;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<Veridia | null>(null);
  const seen = useRef(new Set<string>());
  const mountedAt = useRef(0);
  const cam = useRef({ x: 0, y: 0, zoom: 1, min: 0.5 });
  const hover = useRef<Hit | null>(null);
  const [reduced, setReduced] = useState(false);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [skyLabel, setSkyLabel] = useState("");
  const [legend, setLegend] = useState(false);
  const [local, setLocal] = useState<WorldEvent[]>([]);
  const [, setTick] = useState(0);
  const { events, status } = useStory();
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Offline (no cast from the service), the offline cast plays a scripted day
  const cast = useMemo(() => (residents.length ? residents : OFFLINE_CAST), [residents]);
  const scripted = !residents.length || status === "down";
  const live = status === "live" && !scripted;
  const liveIds = useMemo(() => new Set(residents.map((r) => r.id)), [residents]);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  // Build the world whenever the cast or motion preference changes; the story so far restores quietly
  useEffect(() => {
    const v = new Veridia(cast, reduced);
    world.current = v;
    seen.current = new Set();
    mountedAt.current = Date.now();
    const now = performance.now();
    for (const e of [...eventsRef.current].reverse()) {
      seen.current.add(`${e.at}-${e.who}-${e.action}`);
      v.ingest(e, now, true);
    }
  }, [cast, reduced]);

  // Feed story events into the world; the backlog restores state quietly, new events animate
  useEffect(() => {
    const v = world.current;
    if (!v) return;
    for (const e of [...events].reverse()) {
      const key = `${e.at}-${e.who}-${e.action}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      v.ingest(e, performance.now(), e.at < mountedAt.current - 3000);
    }
  }, [events]);

  // The scripted day: a moment every several seconds, only while the story service is away and the tab is visible
  useEffect(() => {
    if (!scripted) return;
    const day = new ScriptedDay(residents);
    let timer: ReturnType<typeof setTimeout>;
    const next = (first = false) => {
      timer = setTimeout(
        () => {
          if (!document.hidden) {
            const e = day.next();
            world.current?.ingest(e, performance.now(), false);
            setLocal((prev) => [e, ...prev].slice(0, 12));
          }
          next();
        },
        first ? 1200 : 5500 + Math.random() * 4500,
      );
    };
    next(true);
    return () => clearTimeout(timer);
  }, [scripted, residents]);

  // Keep the card current while it's open
  useEffect(() => {
    if (!picked) return;
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPicked(null);
    window.addEventListener("keydown", esc);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", esc);
    };
  }, [picked]);

  // Rendering loop, camera and input
  useEffect(() => {
    const cv = canvas.current;
    const box = wrap.current;
    if (!cv || !box) return;
    const ctx = cv.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // The painted world, drawn once at up to 2× world size for crisp zooming
    const scale = Math.min(2, (window.screen.width * dpr) / W + 0.5);
    const stat = document.createElement("canvas");
    stat.width = Math.round(W * scale);
    stat.height = Math.round(H * scale);
    const sctx = stat.getContext("2d")!;
    sctx.scale(scale, scale);
    paintStatic(
      sctx,
      cast.map((r) => ({ id: r.id, home: homeOf(r.id, r.city) })),
    );

    let cw = 0;
    let ch = 0;
    const fit = () => {
      const r = box.getBoundingClientRect();
      cw = r.width;
      ch = r.height;
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      cv.style.width = `${cw}px`;
      cv.style.height = `${ch}px`;
      const cover = Math.max(cw / W, ch / H);
      const c = cam.current;
      c.min = Math.min(cw / W, ch / H);
      if (focus) {
        const home = homeOf(focus, cast.find((x) => x.id === focus)?.city ?? "Meldan");
        c.zoom = cover * 2.6;
        c.x = home.x - cw / c.zoom / 2;
        c.y = home.y - ch / c.zoom / 2 - 20;
      } else {
        // Narrow screens open on Meldan, the board, the forest and the mountain, with the couriers' post in view
        c.zoom = cover;
        c.x = cw < 640 ? 580 - cw / c.zoom / 2 : (W - cw / c.zoom) / 2;
        c.y = (H - ch / c.zoom) / 2;
      }
      clamp();
    };
    const clamp = () => {
      const c = cam.current;
      c.zoom = Math.max(c.min, Math.min(c.zoom, Math.max(cw / W, ch / H) * 5));
      const vw = cw / c.zoom;
      const vh = ch / c.zoom;
      c.x = vw >= W ? (W - vw) / 2 : Math.max(0, Math.min(W - vw, c.x));
      c.y = vh >= H ? (H - vh) / 2 : Math.max(0, Math.min(H - vh, c.y));
    };
    const toWorld = (sx: number, sy: number): Pt => ({ x: cam.current.x + sx / cam.current.zoom, y: cam.current.y + sy / cam.current.zoom });
    const zoomAt = (sx: number, sy: number, factor: number) => {
      const before = toWorld(sx, sy);
      cam.current.zoom *= factor;
      clamp();
      const after = toWorld(sx, sy);
      cam.current.x += before.x - after.x;
      cam.current.y += before.y - after.y;
      clamp();
      draw(performance.now());
    };

    let sky = skyAt();
    setSkyLabel(sky.label);
    const skyTimer = setInterval(() => {
      sky = skyAt();
      setSkyLabel(sky.label);
    }, 10_000);

    const draw = (now: number) => {
      const v = world.current;
      const c = cam.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ECF0EC";
      ctx.fillRect(0, 0, cw, ch);
      ctx.setTransform(dpr * c.zoom, 0, 0, dpr * c.zoom, -c.x * dpr * c.zoom, -c.y * dpr * c.zoom);
      ctx.drawImage(stat, 0, 0, W, H);
      v?.draw(ctx, now, sky, hover.current, c.zoom);
    };

    // The loop runs only while the tab is visible and the map is on screen
    let raf = 0;
    let last = performance.now();
    let onScreen = true;
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      world.current?.update(dt, now);
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (reduced || raf || document.hidden || !onScreen) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const visibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", visibility);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) start();
      else stop();
    });
    io.observe(box);

    // Reduced motion: a still world, redrawn a few times a second so new events still show up
    const stillTimer = reduced
      ? setInterval(() => {
          if (document.hidden || !onScreen) return;
          const now = performance.now();
          world.current?.update(1000, now);
          draw(now);
        }, 400)
      : null;
    fit();
    draw(performance.now());
    start();

    const ro = new ResizeObserver(() => {
      fit();
      draw(performance.now());
    });
    ro.observe(box);

    // Input: drag to pan (horizontal swipes on touch, so vertical swipes still scroll the page), pinch to zoom
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch = 0;
    const local = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, local(e));
      moved = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      cv.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === "mouse") {
          hover.current = world.current?.hit(toWorld(p.x, p.y)) ?? null;
          cv.style.cursor = hover.current ? "pointer" : "grab";
          if (reduced) draw(performance.now());
        }
        return;
      }
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        moved += 10;
        return;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      cam.current.x -= dx / cam.current.zoom;
      cam.current.y -= dy / cam.current.zoom;
      clamp();
      if (reduced) draw(performance.now());
    };
    const up = (e: PointerEvent) => {
      const p = local(e);
      const wasTap = pointers.size === 1 && moved < 6;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (wasTap) {
        const h = world.current?.hit(toWorld(p.x, p.y)) ?? null;
        setPicked(h);
        if (e.pointerType !== "mouse") hover.current = h;
        if (reduced) draw(performance.now());
      }
    };
    const leave = () => {
      hover.current = null;
    };
    // Wheel zooms only with a modifier, so scrolling the page past the map still works
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY / 400));
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", leave);
    cv.addEventListener("wheel", wheel, { passive: false });
    const zoomButtons = (f: number) => () => zoomAt(cw / 2, ch / 2, f);
    const zin = box.querySelector<HTMLButtonElement>("[data-zoom=in]");
    const zout = box.querySelector<HTMLButtonElement>("[data-zoom=out]");
    const zinH = zoomButtons(1.35);
    const zoutH = zoomButtons(1 / 1.35);
    zin?.addEventListener("click", zinH);
    zout?.addEventListener("click", zoutH);

    return () => {
      stop();
      if (stillTimer) clearInterval(stillTimer);
      clearInterval(skyTimer);
      document.removeEventListener("visibilitychange", visibility);
      io.disconnect();
      ro.disconnect();
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("pointerleave", leave);
      cv.removeEventListener("wheel", wheel);
      zin?.removeEventListener("click", zinH);
      zout?.removeEventListener("click", zoutH);
    };
  }, [cast, focus, reduced]);

  const feed = (scripted ? local : events).filter((e) => e.action !== "rest" || /walk/i.test(e.line)).slice(0, 2);

  return (
    <div ref={wrap} className={clsx("relative overflow-hidden rounded-lg bg-snow ring-1 ring-frost", className)}>
      <canvas ref={canvas} role="img" aria-label={label} className="block touch-pan-y select-none" style={{ cursor: "grab" }} />

      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-4.5rem)] flex-col items-start gap-1.5">
        <div className="flex items-center gap-2 rounded-full bg-snow/85 px-3 py-1 text-[0.78rem] text-pine ring-1 ring-frost">
          <span className={clsx("h-2 w-2 shrink-0 rounded-full", live ? "bg-pad" : scripted ? "bg-candle" : "bg-frost")} aria-hidden />
          <span className="truncate">{live ? "The story runs a little behind the chain" : scripted ? "A scripted day: the story service is offline" : "Connecting…"}</span>
        </div>
        {skyLabel && <div className="rounded-full bg-snow/75 px-3 py-0.5 text-[0.72rem] text-lichen ring-1 ring-frost/70">{skyLabel}</div>}
      </div>

      <button
        type="button"
        onClick={() => setLegend((x) => !x)}
        aria-expanded={legend}
        aria-controls="veridia-legend"
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full bg-snow/90 font-story text-sm italic text-pine ring-1 ring-frost hover:bg-drift focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine"
        aria-label="What am I looking at?"
      >
        ?
      </button>
      {legend && (
        <div id="veridia-legend" className="absolute right-3 top-12 w-[min(18rem,calc(100%-1.5rem))] rounded-md bg-snow/95 p-3 text-[0.8rem] leading-snug text-pine shadow-sm ring-1 ring-frost">
          <ul className="space-y-1.5">
            <li className="flex gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-pad" aria-hidden />
              Green light: money moving privately. A meal paid at a pad, an allowance between homes, a tax share to the couriers.
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-candle" aria-hidden />
              Gold sparks: zipcoins burned, to knock at a door or to be heard. A lantern rises with the message.
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate" aria-hidden />
              Slate: couriers in slate cloaks carry sealed proofs, hold them a while, then send them. Unsigned notes and poll answers arrive by courier.
            </li>
          </ul>
          <p className="mt-2 text-lichen">Tap anyone, or any place, to see who they are and what they did lately. The story is told a while after it happens and leaves out the details, so nothing here lines up with a transaction.</p>
        </div>
      )}

      {!picked && !focus && feed.length > 0 && (
        <ol className="pointer-events-none absolute bottom-3 left-3 flex max-w-[min(28rem,calc(100%-4.5rem))] flex-col-reverse gap-1" aria-hidden>
          {feed.map((e, i) => {
            const t = tone(e.action);
            return (
              <li
                key={`${e.at}-${e.who}-${i}`}
                className={clsx(
                  "flex items-center gap-2 rounded-md bg-snow/85 px-2.5 py-1 text-[0.78rem] text-pine ring-1 ring-frost/80 transition-opacity duration-700",
                  i > 0 && "hidden sm:flex",
                  i === 1 && "opacity-70",
                )}
              >
                <span className={clsx("h-2 w-2 shrink-0 rounded-full", t === "pad" ? "bg-pad" : t === "candle" ? "bg-candle" : t === "slate" ? "bg-slate" : "bg-frost")} />
                <span className="truncate font-story text-[0.9rem]">{e.line}</span>
              </li>
            );
          })}
        </ol>
      )}

      {picked && <Card hit={picked} cast={cast} world={world.current} linkable={liveIds} onClose={() => setPicked(null)} />}

      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md bg-snow/90 ring-1 ring-frost">
        <button data-zoom="in" className="px-2.5 py-1 text-lg leading-none text-pine hover:bg-drift" aria-label="Zoom in">
          +
        </button>
        <button data-zoom="out" className="border-t border-frost px-2.5 py-1 text-lg leading-none text-pine hover:bg-drift" aria-label="Zoom out">
          −
        </button>
      </div>
    </div>
  );
}

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Who (or what) was tapped: a resident's name, bio and doings, a shop, a courier, or a place. */
function Card({ hit, cast, world, linkable, onClose }: { hit: Hit; cast: Resident[]; world: Veridia | null; linkable: Set<string>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), [hit]);

  let title = "";
  let sub = "";
  let body = "";
  let now: string | null = null;
  let last: { line: string; at: number; when?: string } | null = null;
  let href: string | null = null;
  if (hit.kind === "resident" || hit.kind === "shop") {
    const r = cast.find((x) => x.id === hit.id);
    if (!r) return null;
    const s = world?.status(r.id);
    title = r.name;
    sub = r.shop ? `A shop in ${r.city}` : `Lives in ${r.city}`;
    body = r.bio;
    now = r.shop ? null : s?.doing ?? (s?.home ? "At home" : null);
    last = s?.last ?? null;
    if (linkable.has(r.id)) href = `/resident/${r.id}`;
  } else if (hit.kind === "courier") {
    title = "A courier";
    sub = "One of Veridia's couriers";
    body = COURIER_NOTE;
  } else {
    const l = LANDMARKS.find((x) => x.id === hit.id);
    if (!l) return null;
    title = l.name;
    body = l.note;
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      className="absolute bottom-2 left-2 right-12 max-h-[70%] overflow-y-auto rounded-md bg-snow/95 p-3.5 text-pine shadow-sm ring-1 ring-frost focus:outline-none sm:left-auto sm:bottom-3 sm:right-14 sm:w-80"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-story text-lg leading-tight">{title}</p>
          {sub && <p className="text-[0.78rem] text-lichen">{sub}</p>}
        </div>
        <button type="button" onClick={onClose} className="-mr-1 -mt-1 rounded px-1.5 text-lg leading-none text-lichen hover:text-pine" aria-label="Close">
          ×
        </button>
      </div>
      <p className="mt-2 line-clamp-3 text-[0.84rem] leading-snug text-pine/85">{body}</p>
      {now && (
        <p className="mt-2 text-[0.82rem]">
          <span className="text-lichen">Now: </span>
          {now[0].toUpperCase() + now.slice(1)}
        </p>
      )}
      {last && (
        <p className="mt-1 text-[0.82rem] leading-snug">
          <span className="text-lichen">Last, {last.when ?? ago(last.at)}: </span>
          <span className="font-story text-[0.95rem]">{last.line}</span>
        </p>
      )}
      {href && (
        <Link href={href} className="mt-2 inline-block text-[0.82rem] underline decoration-frost underline-offset-2 hover:decoration-pine">
          {title}&apos;s page
        </Link>
      )}
    </div>
  );
}
