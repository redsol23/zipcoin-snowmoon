// The static half of /ledger/: each allowlisted contract's role and who controls it, drawn at build time from the same
// allowlist the stats API uses (apps/stats/public-contracts.json). Entries that are off are never read past their key,
// so nothing about an unreleased feature reaches the site. The live half (addresses, balances, flows) is filled in by
// data.js from https://api.zipcoin.org once the contracts are on mainnet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "..", "apps", "stats", "public-contracts.json");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Where the money sits and who can move it, listed first; every other shown entry follows in file order */
const MONEY = ["pool", "entrypoint", "zc", "pay", "bands", "safe"];
const CHIP = { none: "No owner", safe: "2-of-3 Safe", external: "Not a zipcoin contract" };

export function shownContracts() {
  const { contracts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const shown = contracts.filter((c) => c.show === true);
  for (const c of shown)
    for (const f of ["key", "name", "contract", "control", "role", "controller"]) if (!c[f]) throw new Error(`public-contracts.json: ${c.key} has no ${f}`);
  return shown;
}

// The public site names the token only as ZC; other projects' names stay off it.
const kind = (contract) => contract;

function card(c) {
  const powers = (c.powers ?? []).length ? `\n      <ul class="lg-powers">${c.powers.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  // A holder of ZC also earns the token's ETH rewards; the token itself holds none of either
  const holds = c.key !== "zc";
  return `    <li class="lg-c" id="c-${esc(c.key)}" data-key="${esc(c.key)}">
      <div class="lg-c-head">
        <h3>${esc(c.name)}</h3>
        <span class="lg-chip lg-chip-${esc(c.control)}">${esc(CHIP[c.control] ?? c.control)}</span>
      </div>
      <p class="lg-kind">${esc(kind(c.contract))}</p>
      <p class="lg-role">${esc(c.role)}</p>
      <p class="lg-ctl"><strong>Who controls it.</strong> ${esc(c.controller)}</p>${powers}
      <dl class="lg-live">
        <div class="lg-addr"><dt>Address</dt><dd data-f="address">At launch</dd></div>${
          holds
            ? `
        <div><dt>ETH</dt><dd data-f="eth">—</dd></div>
        <div><dt>ZC</dt><dd data-f="zc">—</dd></div>
        <div><dt>ETH rewards waiting</dt><dd data-f="pending">—</dd></div>`
            : ""
        }
        <div class="lg-extra" data-f="live" hidden><dt>On-chain now</dt><dd></dd></div>
      </dl>
    </li>`;
}

export function contractsHtml() {
  const shown = shownContracts();
  const money = MONEY.map((k) => shown.find((c) => c.key === k)).filter(Boolean);
  const rest = shown.filter((c) => !MONEY.includes(c.key));
  return `<h3 class="lg-group">Where the money sits</h3>
  <ul class="lg-cards">
${money.map(card).join("\n")}
  </ul>
  <h3 class="lg-group">Everything else</h3>
  <ul class="lg-cards">
${rest.map(card).join("\n")}
  </ul>`;
}
