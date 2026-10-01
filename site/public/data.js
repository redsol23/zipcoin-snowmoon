// zipcoin.org: the live numbers on /ledger/, /privacy-meter/ and /status/. It reads one first-party address,
// https://api.zipcoin.org, and sends nothing but the request. Until that answers (before launch, or if it's down) the
// page keeps its "Goes live at launch" state and the roles and controllers drawn at build time. Everything from the
// API is written with textContent, never as HTML.
"use strict";

(function data() {
  const page = document.body.dataset.page;
  const state = document.querySelector("[data-live-state]");
  if (!page || !state) return;
  const said = state.querySelector("[data-live-text]");

  // Local preview only: ?api=http://127.0.0.1:<port> points the page at a local stats service
  const API = (() => {
    const q = new URLSearchParams(location.search).get("api");
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return local && q && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(q) ? q : "https://api.zipcoin.org";
  })();
  const PATH = { ledger: "/v1/ledger", privacy: "/v1/privacy", status: "/v1/status" }[page];
  if (!PATH) return;

  const WEI = 10n ** 18n;
  const LABEL = { "24h": "in the last 24 hours", "7d": "in the last 7 days", all: "since launch" };
  let win = "7d";
  let doc = null;

  // ------------------------------------------------------------------ formatting

  function amount(wei, unit) {
    if (wei === null || wei === undefined) return "—";
    let v;
    try { v = BigInt(wei); } catch { return "—"; }
    const n = Number(v / WEI) + Number(v % WEI) / 1e18;
    if (n === 0) return `0 ${unit}`;
    const opts = n >= 1e6 ? { notation: "compact", maximumFractionDigits: 2 } : n >= 1000 ? { maximumFractionDigits: 0 } : n >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 };
    return `${new Intl.NumberFormat("en", opts).format(n)} ${unit}`;
  }
  const count = (n) => (typeof n === "number" ? new Intl.NumberFormat("en").format(n) : "—");
  function ago(sec) {
    if (typeof sec !== "number") return "—";
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
    return `${Math.floor(sec / 86400)} days ago`;
  }
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const set = (el, text) => { if (el) el.textContent = text; };

  function addressNode(a, chainId) {
    if (chainId === 1) {
      const link = document.createElement("a");
      link.href = `https://etherscan.io/address/${a}`;
      link.rel = "noreferrer noopener";
      link.className = "lg-code";
      link.textContent = short(a);
      link.title = a;
      return link;
    }
    const code = document.createElement("code");
    code.className = "lg-code";
    code.textContent = short(a);
    code.title = a;
    return code;
  }

  function live(text, ok) {
    state.dataset.liveState = ok ? "live" : "waiting";
    said.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = ok ? "Live." : "Goes live at launch.";
    said.append(strong, ` ${text}`);
  }

  function windowButtons(render) {
    const box = document.querySelector(".lg-win");
    if (!box) return;
    box.hidden = false;
    for (const b of box.querySelectorAll("button")) {
      b.addEventListener("click", () => {
        win = b.dataset.win;
        for (const o of box.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        render();
      });
    }
  }

  // ------------------------------------------------------------------ the ledger

  function flowValue(path) {
    const [flow, a, b] = path.split(".");
    const f = doc.flows[flow];
    if (!f) return undefined;
    return b === undefined ? f[win] && f[win][a] : f[a] && f[a][win] && f[a][win][b];
  }

  function renderFlows() {
    for (const card of document.querySelectorAll("[data-flow]")) {
      const f = doc.flows[card.dataset.flow];
      if (card.dataset.flow === "emerald") card.hidden = !f;
      card.classList.toggle("lg-off", !f);
    }
    for (const el of document.querySelectorAll("[data-v]")) {
      const path = el.dataset.v;
      const v = flowValue(path);
      const last = path.split(".").pop();
      if (last === "count") {
        const noun = path.startsWith("poolHarvests") ? ["harvest", "harvests"] : ["payment", "payments"];
        set(el, v === undefined ? "" : `From ${count(v)} ${v === 1 ? noun[0] : noun[1]}.`);
        continue;
      }
      const unit = last === "eth" || path === "poolHarvests.forwarded" ? "ETH" : "ZC";
      if (el.classList.contains("lg-and")) set(el, v && v !== "0" ? ` + ${amount(v, unit)}` : "");
      else set(el, doc.flows[path.split(".")[0]] ? amount(v, unit) : "Not live yet");
    }
    const tax = doc.flows.salesTax && doc.flows.salesTax[win];
    if (tax) {
      const parts = ["burned", "couriers", "treasury"].map((k) => BigInt(tax[k]));
      const total = parts.reduce((x, y) => x + y, 0n);
      document.querySelectorAll("[data-w]").forEach((el, i) => {
        el.style.width = total > 0n ? `${Number((parts[i] * 10000n) / total) / 100}%` : "0";
      });
    }
  }

  function liveFacts(c) {
    const l = c.live;
    if (!l || l.error) return null;
    if (c.key === "safe") return l.isSafe === false ? "This address is not a Safe contract." : `${l.threshold} of ${l.signers} signers needed.`;
    if (c.key === "entrypoint") {
      const owners = (l.owners || []).map((o) => (o.is ? `the ${o.is}` : short(o.address)));
      return `Upgradeable. Owner: ${owners.join(", ") || "none"}. Postman: ${(l.postman || []).map(short).join(", ") || "none"}.`;
    }
    if (c.key === "bands") return l.paused ? "Paused by the Safe." : "Running.";
    if (c.key === "pay" && l.split) return `Tax ${l.taxBps / 100}%: ${l.split.burnBps / 100}% burned, ${l.split.couriersBps / 100}% to couriers, ${l.split.treasuryBps / 100}% to the treasury's share.`;
    return null;
  }

  function renderContracts() {
    const byKey = new Map(doc.contracts.map((c) => [c.key, c]));
    for (const card of document.querySelectorAll(".lg-c[data-key]")) {
      const c = byKey.get(card.dataset.key);
      if (!c) continue;
      const addr = card.querySelector('[data-f="address"]');
      if (c.address) {
        addr.textContent = "";
        addr.append(addressNode(c.address, doc.chainId));
      } else set(addr, "Not deployed yet");
      const b = c.balances || {};
      set(card.querySelector('[data-f="eth"]'), amount(b.eth, "ETH"));
      set(card.querySelector('[data-f="zc"]'), amount(b.zc, "ZC"));
      set(card.querySelector('[data-f="pending"]'), b.zcRewardsPending === null ? "—" : amount(b.zcRewardsPending, "ETH"));
      const extra = card.querySelector('[data-f="live"]');
      const facts = liveFacts(c);
      if (extra) {
        extra.hidden = !facts;
        set(extra.querySelector("dd"), facts || "");
      }
    }
  }

  // ------------------------------------------------------------------ the privacy meter

  function renderPrivacy() {
    if (!doc.enabled) return;
    const w = doc.windows[win];
    if (!w) return;
    for (const el of document.querySelectorAll("[data-p]")) {
      const k = el.dataset.p;
      set(el, k === "windowLabel" ? LABEL[win] : count(w[k]));
    }
    const max = Math.max(1, ...w.buckets.map((b) => b.deposits));
    w.buckets.forEach((b, i) => {
      const bar = document.querySelector(`[data-b="${i}"]`);
      if (bar) bar.style.width = `${(b.deposits / max) * 100}%`;
      set(document.querySelector(`[data-bn="${i}"]`), count(b.deposits));
    });
  }

  // ------------------------------------------------------------------ status

  function cell(row, content, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (typeof content === "string") td.textContent = content;
    else td.append(...content);
    row.append(td);
    return td;
  }

  function renderStatus() {
    const p = doc.postman || {};
    set(document.querySelector('[data-s="postman.reachable"]'), !p.configured ? "Not listed" : p.reachable ? "Yes" : `No${p.error ? ` (${p.error})` : ""}`);
    set(document.querySelector('[data-s="postman.age"]'), p.lastRoot ? ago(p.lastRoot.ageSec) : "None yet");
    set(document.querySelector('[data-s="postman.epoch"]'), p.lastRoot ? `Every ${p.lastRoot.epochSec >= 3600 ? `${p.lastRoot.epochSec / 3600} h` : `${Math.round(p.lastRoot.epochSec / 60)} min`}` : "—");
    set(document.querySelector('[data-s="postman.approved"]'), typeof p.approved === "number" ? count(p.approved) : "—");

    const body = document.querySelector('[data-s="couriers"]');
    if (!body) return;
    body.textContent = "";
    if (!doc.couriers.length) {
      const row = document.createElement("tr");
      row.className = "st-empty";
      cell(row, "No couriers are bonded yet.").colSpan = 5;
      body.append(row);
      return;
    }
    for (const c of doc.couriers) {
      const row = document.createElement("tr");
      let host = "";
      try { host = new URL(c.endpoint).host; } catch { host = ""; }
      const hostEl = document.createElement("span");
      hostEl.className = "st-host";
      hostEl.textContent = host;
      cell(row, [addressNode(c.address, doc.chainId), hostEl], "st-who");
      cell(row, amount(c.bond, "ZC")).dataset.label = "Bond";
      const up = c.unbonding ? "Leaving" : c.reachable ? `Yes, ${c.latencyMs} ms` : c.reachable === false ? `No${c.error ? ` (${c.error})` : ""}` : "—";
      const upCell = cell(row, up, c.reachable ? "st-up" : c.unbonding ? "st-leaving" : "st-down");
      upCell.dataset.label = "Answering";
      cell(row, c.lastJobAgeSec === null ? "—" : ago(c.lastJobAgeSec)).dataset.label = "Last job";
      cell(row, c.version || "—").dataset.label = "Version";
      body.append(row);
    }
  }

  // ------------------------------------------------------------------ fetch and refresh

  const render = () => {
    if (!doc) return;
    if (page === "ledger") { renderFlows(); renderContracts(); }
    if (page === "privacy") renderPrivacy();
    if (page === "status") renderStatus();
  };

  async function load() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(API + PATH, { signal: ctl.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(String(res.status));
      const got = await res.json();
      if (!got || got.ok !== true) throw new Error("not ready");
      const first = !doc;
      doc = got;
      render();
      if (first && page !== "status") windowButtons(render);
      const chain = got.chainId === 1 ? "Ethereum" : `test chain ${got.chainId}`;
      live(`Read from ${chain} at block ${count(Number(got.block))}, ${ago(Math.max(0, Math.floor(Date.now() / 1000) - got.updatedAt))}.`, true);
    } catch {
      if (doc) live("Couldn't reach the data just now; these are the last numbers read.", true);
    } finally {
      clearTimeout(timer);
    }
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, 60_000);
})();
