import fs from "node:fs";
import path from "node:path";
import { Identity } from "@semaphore-protocol/core";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createPublicClient, createWalletClient, hexToBytes, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { masterKeys, parseDeployment, zipAddressKeys } from "@zipnet/sdk";

import { CAST, type Character } from "./cast";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const cfg = {
  rpcUrl: env("RPC_URL"),
  dep: parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8")),
  courierUrl: env("COURIER_URL", "http://127.0.0.1:8720"),
  /** Funds the cast at bootstrap (ETH for gas, ZC purses). Only needed the first time. */
  treasuryKey: process.env.TREASURY_KEY as Hex | undefined,
  seed: env("VERIDIA_SEED"),
  dataDir: env("DATA_DIR", path.resolve(".veridia")),
  port: Number(env("PORT", "8730")),
  /** Mean character actions per hour across the whole cast */
  actionsPerHour: Number(env("ACTIONS_PER_HOUR", "60")),
  /** Longest a character asks a courier to hold a proof (random within it) */
  maxHoldSec: Number(env("MAX_HOLD_SEC", "600")),
  useLlm: env("VERIDIA_LLM", "auto"),
};
fs.mkdirSync(cfg.dataDir, { recursive: true });

export const pub = createPublicClient({ transport: http(cfg.rpcUrl) });

/** Everything a character needs to act, derived from the world seed so a restart finds the same people. */
export function identityOf(c: Character) {
  const derive = (what: string) => keccak256(toHex(`${cfg.seed}/${c.id}/${what}`));
  const account = privateKeyToAccount(derive("wallet"));
  const mnemonic = entropyToMnemonic(hexToBytes(derive("zip")).slice(0, 16), wordlist);
  const keys = masterKeys(mnemonic);
  return {
    account,
    wallet: createWalletClient({ account, transport: http(cfg.rpcUrl) }),
    keys,
    zipAddress: zipAddressKeys(keys.masterSecret),
    semaphore: new Identity(`${cfg.seed}/${c.id}/semaphore`),
  };
}
export type Who = ReturnType<typeof identityOf>;
export const people = new Map(CAST.map((c) => [c.id, identityOf(c)]));

// ---------------------------------------------------------------------------------------------------------------
// the world log: every action, in character, public (it is also what the web app's Veridia feed shows)
// ---------------------------------------------------------------------------------------------------------------

export type Event = { at: number; who: string; action: string; line: string; detail?: Record<string, unknown>; tx?: string; job?: string };

const LOG = path.join(cfg.dataDir, "world.jsonl");
export const events: Event[] = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

export function record(e: Omit<Event, "at">) {
  const ev = { at: Date.now(), ...e };
  events.push(ev);
  fs.appendFileSync(LOG, JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  console.log(`[veridia] ${ev.who}: ${ev.line}`);
  return ev;
}

// ---------------------------------------------------------------------------------------------------------------
// persistent facts (merchant ids, badge locks) so bootstrap is idempotent
// ---------------------------------------------------------------------------------------------------------------

const FACTS = path.join(cfg.dataDir, "facts.json");
export const facts: { merchantId: Record<string, string>; badged: string[]; funded: string[]; voted: Record<string, string[]> } = {
  merchantId: {},
  badged: [],
  funded: [],
  voted: {},
  ...(fs.existsSync(FACTS) ? JSON.parse(fs.readFileSync(FACTS, "utf8")) : {}),
};
export const saveFacts = () => fs.writeFileSync(FACTS, JSON.stringify(facts, null, 1));
