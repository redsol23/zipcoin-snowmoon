"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { Resident, WorldEvent } from "@/lib/veridia";

import { useStory } from "../World";

import { H, homeOf, paintStatic, W, type Pt } from "./scene";
import { darkness, Veridia } from "./sim";

/**
 * Veridia, alive. A painted world (drawn once) under a living layer (every frame): residents walking to shops and
 * doors, lights where payments and burns happen, notes on the board, neighbours gathering for polls, snow, and night
 * following the viewer's clock. Driven by the public story feed only.
 *
 * Drag to look around, pinch or use the buttons to zoom, click a resident to open their page. With reduced motion
 * the world is drawn still and updates only when something happens.
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
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<Veridia | null>(null);
  const seen = useRef(new Set<string>());
  const mountedAt = useRef(0);
  const cam = useRef({ x: 0, y: 0, zoom: 1, min: 0.5 });
  const hover = useRef<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const [live, setLive] = useState(false);
  const { events, status } = useStory();

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  // Build the world whenever the cast or motion preference changes
  useEffect(() => {
    if (!residents.length) return;
    world.current = new Veridia(residents, reduced);
    seen.current = new Set();
    mountedAt.current = Date.now();
  }, [residents, reduced]);

  // Feed story events into the world; the backlog restores state quietly, new events animate
  useEffect(() => {
    const v = world.current;
    if (!v) return;
    for (const e of [...events].reverse()) {
      const key = `${e.at}-${e.who}-${e.action}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      v.ingest(e as WorldEvent, performance.now(), e.at < mountedAt.current - 3000);
    }
    setLive(status === "live");
  }, [events, status]);

  // Rendering loop, camera and input
  useEffect(() => {
    const cv = canvas.current;
    const box = wrap.current;
    if (!cv || !box || !residents.length) return;
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
      residents.map((r) => ({ id: r.id, home: homeOf(r.id, r.city) })),
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
        const home = homeOf(focus, residents.find((x) => x.id === focus)?.city ?? "Meldan");
        c.zoom = cover * 2.6;
        c.x = home.x - cw / c.zoom / 2;
        c.y = home.y - ch / c.zoom / 2 - 20;
      } else {
        c.zoom = cover;
        c.x = (W - cw / c.zoom) / 2;
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

    let dark = darkness();
    const darkTimer = setInterval(() => (dark = darkness()), 60_000);

    const draw = (now: number) => {
      const v = world.current;
      const c = cam.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ECF0EC";
      ctx.fillRect(0, 0, cw, ch);
      ctx.setTransform(dpr * c.zoom, 0, 0, dpr * c.zoom, -c.x * dpr * c.zoom, -c.y * dpr * c.zoom);
      ctx.drawImage(stat, 0, 0, W, H);
      v?.draw(ctx, now, dark, hover.current, c.zoom);
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (!document.hidden) {
        world.current?.update(dt, now);
        draw(now);
      }
      raf = requestAnimationFrame(frame);
    };
    // Reduced motion: a still world, redrawn a few times a second so new events still show up
    const stillTimer = reduced
      ? setInterval(() => {
          const now = performance.now();
          world.current?.update(1000, now);
          draw(now);
        }, 400)
      : null;
    fit();
    if (!reduced) raf = requestAnimationFrame(frame);
    else draw(performance.now());

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
        const id = world.current?.hit(toWorld(p.x, p.y));
        if (id) router.push(`/resident/${id}`);
      }
    };
    const leave = () => {
      hover.current = null;
    };
    // Wheel zooms only with a modifier, so scrolling the page past the map still works
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const p = { x: e.offsetX, y: e.offsetY };
      zoomAt(p.x, p.y, Math.exp(-e.deltaY / 400));
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
      cancelAnimationFrame(raf);
      if (stillTimer) clearInterval(stillTimer);
      clearInterval(darkTimer);
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
  }, [residents, focus, reduced, router]);

  return (
    <div ref={wrap} className={clsx("relative overflow-hidden rounded-lg bg-snow ring-1 ring-frost", className)}>
      <canvas ref={canvas} role="img" aria-label={label} className="block touch-pan-y select-none" style={{ cursor: "grab" }} />
      {!residents.length && (
        <p className="absolute inset-0 grid place-items-center font-story text-lg italic text-lichen">Veridia is waking up…</p>
      )}
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-snow/85 px-3 py-1 text-[0.78rem] text-pine ring-1 ring-frost">
        <span className={clsx("h-2 w-2 rounded-full", live ? "bg-pad" : "bg-frost")} aria-hidden />
        {live ? "Live from the chain" : status === "down" ? "The story service isn't answering" : "Connecting…"}
      </div>
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
