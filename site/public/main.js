// zipcoin.org: forwarding of old links, the copy button, the phone menu, and the hero's snowfall. Nothing is sent
// anywhere. Everything here is an enhancement: without this script every word and picture is already on the page.
"use strict";

// The details used to be one page with anchors (/learn/#faq and so on); send old links to the page they moved to.
(function movedAnchors() {
  if (location.pathname !== "/learn/" || !location.hash) return;
  const to = {
    "#how": "/learn/privacy/", "#different": "/learn/privacy/#different", "#pool": "/learn/privacy/#pool",
    "#book": "/learn/novel/", "#couriers": "/learn/couriers/", "#veridia": "/learn/veridia/",
    "#safety": "/learn/faq/#safety", "#faq": "/learn/faq/",
  }[location.hash];
  if (to) location.replace(to);
})();

(function copyButtons() {
  for (const btn of document.querySelectorAll("button[data-copy]")) {
    const source = document.getElementById(btn.dataset.copy);
    const status = btn.closest(".token")?.querySelector(".copied");
    if (!source || !navigator.clipboard) continue;
    const label = btn.textContent;
    btn.hidden = false;
    let timer = 0;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        btn.classList.add("done");
        btn.innerHTML = '<span class="tick" aria-hidden="true"></span>Copied';
        clearTimeout(timer);
        timer = setTimeout(() => { btn.classList.remove("done"); btn.textContent = label; }, 2400);
        if (status) status.textContent = "Address copied. Check it again wherever you paste it.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (status) status.textContent = "Couldn't copy automatically. The address is selected; copy it with your keyboard.";
      }
    });
  }
})();

// The phone menu: a <details> (so it works without this script) made into a proper disclosure. Escape closes it,
// focus stays inside while it's open and goes back to the button after, and following a link closes it.
(function menu() {
  const box = document.querySelector("details.menu");
  if (!box) return;
  const btn = box.querySelector("summary");
  const panel = box.querySelector(".menu-panel");
  btn.setAttribute("aria-controls", panel.id);
  const sync = () => btn.setAttribute("aria-expanded", String(box.open));
  sync();
  const close = (focus) => { box.open = false; sync(); if (focus) btn.focus(); };
  box.addEventListener("toggle", () => {
    sync();
    if (box.open) panel.querySelector("a")?.focus();
  });
  box.addEventListener("keydown", (e) => {
    if (!box.open) return;
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key !== "Tab") return;
    const stops = [btn, ...panel.querySelectorAll("a")];
    const i = stops.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); stops[stops.length - 1].focus(); }
    else if (!e.shiftKey && i === stops.length - 1) { e.preventDefault(); stops[0].focus(); }
  });
  panel.addEventListener("click", (e) => { if (e.target.closest("a")) close(false); });
  document.addEventListener("click", (e) => { if (box.open && !box.contains(e.target)) close(false); });
  // leaving the phone layout closes it
  window.matchMedia("(min-width: 840px)").addEventListener("change", () => close(false));
})();

// The living Veridia scene: its script loads only when the scene comes near the viewport.
(function livingVeridia() {
  const box = document.querySelector(".v-live");
  if (!box || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const s = document.createElement("script");
    s.src = "/veridia-scene.js";
    s.defer = true;
    document.head.append(s);
  }, { rootMargin: "600px 0px" });
  io.observe(box);
})();

/**
 * The hero's snowfall: one small canvas, simple circles, fewer flakes and no high-DPI backing store on phones.
 * It runs only while the hero is on screen and the tab is visible, never over the text, and stands still under
 * reduced motion.
 */
(function snow() {
  const canvas = document.querySelector(".hero .snow");
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phone = window.matchMedia("(max-width: 699px)");
  let flakes = [];
  let keepOut = [];
  let w = 0;
  let h = 0;
  let raf = 0;
  let last = 0;
  let visible = true;
  let color = "#fff";

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, phone.matches ? 1 : 1.5);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color = getComputedStyle(document.documentElement).getPropertyValue("--flake").trim() || "#fff";
    const box = canvas.getBoundingClientRect();
    keepOut = [...document.querySelectorAll(".hero-copy > *, .top-inner > *")].map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - box.left - 14, t: r.top - box.top - 14, r: r.right - box.left + 14, b: r.bottom - box.top + 14 };
    });
    const count = Math.round(Math.min(phone.matches ? 120 : 340, (w * h) / (phone.matches ? 4000 : 3600)));
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.7 + Math.random() * 2.1,
      v: 10 + Math.random() * 24,
      p: Math.random() * Math.PI * 2,
    }));
  }

  function draw(dt, t) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const f of flakes) {
      f.y += f.v * f.r * 0.5 * dt;
      f.x += (Math.sin(t / 1700 + f.p) * 8 + 4) * dt;
      if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
      if (f.x > w + 4) f.x = -4;
      if (keepOut.some((k) => f.x > k.l && f.x < k.r && f.y > k.t && f.y < k.b)) continue;
      ctx.moveTo(f.x + f.r, f.y);
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    draw(dt, t);
    raf = visible && !still.matches && !document.hidden ? requestAnimationFrame(frame) : 0;
  }

  function start() {
    if (still.matches) { draw(0, 0); return; }
    if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); }
  }

  // measure after the first layout, not during it, so the page's first paint stays one short task
  requestAnimationFrame(() => { size(); start(); });
  const refresh = () => { size(); if (still.matches) draw(0, 0); };
  window.addEventListener("resize", refresh);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { size(); start(); });
  still.addEventListener("change", start);
  document.addEventListener("visibilitychange", start);
  if ("IntersectionObserver" in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); }).observe(canvas);
})();
