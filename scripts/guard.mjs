#!/usr/bin/env node
/**
 * Publishing guard. This repo is public; nothing private may reach it.
 *
 *   node scripts/guard.mjs staged        pre-commit: identity + paths + added lines
 *   node scripts/guard.mjs push <range>  pre-push: every commit's author/committer + full diff of the range
 *
 * Blocks: private keys, API/bot tokens, seed phrases (except well-known public test mnemonics), local env/key files,
 * machine paths and hostnames, and any string in the local denylist (.git/guard-denylist.txt: one per line, e.g.
 * personal names, emails and wallet addresses; it lives in .git so it is never committed, and so the names it
 * protects never appear in this public file).
 * A line can opt out with the marker `guard:allow` when it is a known public constant.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();
const gitDir = git("rev-parse", "--git-dir").trim();

const IDENTITY = { name: "redsol", email: "264886981+redsol23@users.noreply.github.com" };

const BLOCKED_PATHS = [
  /(^|\/)\.local\//,
  /(^|\/)\.env($|\.(?!example$))/,
  /\.(key|pem|p12|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(^|\/)contracts\/deployments\/[^/]*local[^/]*\.json$/,
  /(^|\/)(broadcast|cache)\//,
  /(^|\/)\.(courier|veridia|postman-state)/,
  /(^|\/)\.playwright-mcp\//,
];
const BIG_FILE_OK = [/^packages\/sdk\/artifacts\/artifacts\//];
const MAX_BYTES = 2 * 1024 * 1024;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, "Telegram bot token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/(private[_ ]?key|secret|mnemonic|seed)["'\s:=]+["']?(0x)?[0-9a-fA-F]{64}\b/i, "private key assignment"],
  [/\b(0x)?[0-9a-fA-F]{64}\b/, "64-hex value (a private key looks like this)"],
];
// Machine-specific paths and hostnames reveal who built what; personal names live in the local denylist instead
const PERSONAL = [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/i, /\/(c|home)\/(Users\/)?[a-z][\w-]*\/repos\b/i, /DESKTOP-[A-Z0-9]{6,}/];
// Public, documented test mnemonics used in tests and local scripts
const PUBLIC_MNEMONICS = [
  "test test test test test test test test test test test junk",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
];

const denyFile = path.join(gitDir, "guard-denylist.txt");
const DENY = fs.existsSync(denyFile)
  ? fs.readFileSync(denyFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
  : [];

const problems = [];
const flag = (where, what) => problems.push(`${where}: ${what}`);

function scanLine(where, line) {
  if (line.includes("guard:allow")) return;
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(line)) {
      // bytes32 constants and hashes are fine when the line says what they are
      if (what.startsWith("64-hex") && /keccak|typehash|hash|root|digest|salt|commitment|nullifier|scope|topic|selector|bafy|sha256|chainid/i.test(line)) continue;
      flag(where, what);
    }
  }
  for (const re of PERSONAL) if (re.test(line)) flag(where, `personal identity (${re})`);
  for (const d of DENY) if (line.toLowerCase().includes(d.toLowerCase())) flag(where, "matches the local denylist");
  const words = line.toLowerCase().match(/\b[a-z]{3,8}\b/g) ?? [];
  if (words.length >= 12 && !PUBLIC_MNEMONICS.some((m) => line.toLowerCase().includes(m))) {
    // 12+ consecutive short lowercase words inside a quoted string is how seed phrases usually appear
    const q = line.match(/["'`]([a-z]{3,8}(\s+[a-z]{3,8}){11,23})["'`]/);
    if (q) flag(where, "possible seed phrase");
  }
}

function scanDiff(diff) {
  let file = "?";
  let n = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(6);
      continue;
    }
    const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (m) {
      n = Number(m[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      scanLine(`${file}:${n}`, raw.slice(1));
      n++;
    } else if (!raw.startsWith("-")) n++;
  }
}

function checkPaths(files) {
  for (const f of files) {
    if (BLOCKED_PATHS.some((re) => re.test(f))) flag(f, "file type/location must never be committed");
    const abs = path.join(root, f);
    if (fs.existsSync(abs) && fs.statSync(abs).size > MAX_BYTES && !BIG_FILE_OK.some((re) => re.test(f))) flag(f, "larger than 2 MB");
  }
}

function checkIdentity(name, email, who) {
  if (name !== IDENTITY.name || email !== IDENTITY.email) flag(who, `must be "${IDENTITY.name} <${IDENTITY.email}>", is "${name} <${email}>"`);
}

/** Commits are redsol's alone: no co-author or sign-off trailers naming anyone else. */
function checkMessage(msg, where) {
  for (const l of msg.split("\n")) {
    const m = l.match(/^\s*(co-authored-by|signed-off-by|co-developed-by)\s*:\s*(.*)$/i);
    if (m && !m[2].includes(IDENTITY.email)) flag(where, `trailer "${m[1]}: ${m[2]}" names someone other than redsol`);
  }
}

const [mode, range] = process.argv.slice(2);
if (mode === "staged") {
  checkIdentity(git("config", "user.name").trim(), git("config", "user.email").trim(), "git identity");
  checkPaths(git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean));
  scanDiff(git("diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR", "--", ".", ":(exclude)pnpm-lock.yaml"));
} else if (mode === "push") {
  const commits = git("rev-list", range).split("\n").filter(Boolean);
  for (const c of commits) {
    const [an, ae, cn, ce, msg] = git("show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", c).split("\0");
    checkIdentity(an, ae, `${c.slice(0, 7)} author`);
    checkIdentity(cn, ce, `${c.slice(0, 7)} committer`);
    for (const l of msg.split("\n")) scanLine(`${c.slice(0, 7)} message`, l);
    checkMessage(msg, `${c.slice(0, 7)} message`);
    checkPaths(git("show", "--name-only", "--format=", "--diff-filter=ACMR", c).split("\n").filter(Boolean));
    scanDiff(git("show", "-U0", "--no-color", "--format=", "--diff-filter=ACMR", c, "--", ".", ":(exclude)pnpm-lock.yaml"));
  }
} else if (mode === "message") {
  const msg = fs.readFileSync(range, "utf8");
  checkMessage(msg, "commit message");
  for (const l of msg.split("\n")) if (!l.startsWith("#")) scanLine("commit message", l);
} else if (mode === "remote") {
  // Everything that leaves this repo goes out as redsol23: the remote, the credentials git will use, the identity.
  checkIdentity(git("config", "user.name").trim(), git("config", "user.email").trim(), "git identity");
  const url = git("remote", "get-url", "--push", "origin").trim();
  if (!/^https:\/\/github\.com\/redsol23\//.test(url)) flag("origin", `push URL must be https://github.com/redsol23/…, is ${url}`);
  const cred = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  const user = cred.match(/^username=(.*)$/m)?.[1];
  if (user !== "redsol23") flag("credentials", `git would authenticate as ${user ?? "nobody"}, not redsol23`);
} else {
  console.error("usage: guard.mjs staged | push <range> | message <file> | remote");
  process.exit(2);
}

if (problems.length) {
  console.error(`\nguard: ${problems.length} problem(s), nothing was ${mode === "push" ? "pushed" : "committed"}:\n`);
  for (const p of [...new Set(problems)].slice(0, 50)) console.error(`  - ${p}`);
  console.error("\nFix them (or mark a known public constant with `guard:allow`) and try again.\n");
  process.exit(1);
}
console.error(`guard: ${mode} ok`);
