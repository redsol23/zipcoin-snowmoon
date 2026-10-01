import fs from "node:fs";
import path from "node:path";
import { Identity } from "@semaphore-protocol/core";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createPublicClient, createWalletClient, hexToBytes, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { masterKeys, parseDeployment, zipAddressKeys } from "@zipnet/sdk";

import { budgetFile, GasBudget } from "./budget";
import { CAST, type Character } from "./cast";
import { DEEPSEEK_DEFAULT_MODEL } from "./deepseek";
import { splitTransport } from "./rpc";
import { Story, type Happened } from "./story";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const cfg = {
  rpcUrl: env("RPC_URL"),
  /** Optional: where the residents' and the treasury's own transactions are broadcast (reads stay on RPC_URL) */
  sendRpcUrl: process.env.SEND_RPC_URL || undefined,
  dep: parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8")),
  courierUrl: env("COURIER_URL", "http://127.0.0.1:8720"),
  /** Funds the cast at bootstrap (ETH for gas, ZC purses). Only needed the first time. */
  treasuryKey: process.env.TREASURY_KEY as Hex | undefined,
  /** ETH each resident wallet gets at bootstrap, for gas (a testnet needs far less) */
  residentEth: env("VERIDIA_RESIDENT_ETH", "0.5"),
  seed: env("VERIDIA_SEED"),
  dataDir: env("DATA_DIR", path.resolve(".veridia")),
  port: Number(env("PORT", "8730")),
  /** Mean character actions per hour across the whole cast (the action budget; a small one by default) */
  actionsPerHour: Number(env("ACTIONS_PER_HOUR", "6")),
  /**
   * Daily gas cap in wei for everything the world causes on-chain (0 = no cap). Once spent, residents only say scripted
   * lines that touch no chain, and no model is called, until the next UTC day.
   */
  dailyGasWei: BigInt(env("VERIDIA_DAILY_GAS_WEI", "20000000000000000")),
  /** Minutes an anonymous poll lasts */
  cycleMin: Number(env("VERIDIA_CYCLE_MIN", "360")),
  /** Longest a character asks a courier to hold a proof (random within it) */
  maxHoldSec: Number(env("MAX_HOLD_SEC", "600")),
  /** "auto": DeepSeek minds when DEEPSEEK_API_KEY is set, else the scripted mind; "off": always scripted */
  useLlm: env("VERIDIA_LLM", "auto"),
  /** DeepSeek model for the residents' minds */
  model: env("VERIDIA_MODEL", DEEPSEEK_DEFAULT_MODEL),
  /** Each story event is told after an independent random delay in this range (minutes), so the story can't be lined up with the chain */
  storyDelayMin: Number(env("VERIDIA_STORY_DELAY_MIN", "20")),
  storyDelayMax: Number(env("VERIDIA_STORY_DELAY_MAX", "120")),
};
fs.mkdirSync(cfg.dataDir, { recursive: true });

export const budget = new GasBudget(cfg.dailyGasWei, budgetFile(cfg.dataDir));

export const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
/** Wallets read from RPC_URL and broadcast through SEND_RPC_URL when it is set */
export const txTransport = splitTransport(cfg.rpcUrl, cfg.sendRpcUrl);

/** Everything a character needs to act, derived from the world seed so a restart finds the same people. */
export function identityOf(c: Character) {
  const derive = (what: string) => keccak256(toHex(`${cfg.seed}/${c.id}/${what}`));
  const account = privateKeyToAccount(derive("wallet"));
  const mnemonic = entropyToMnemonic(hexToBytes(derive("zip")).slice(0, 16), wordlist);
  const keys = masterKeys(mnemonic);
  return {
    account,
    wallet: createWalletClient({ account, transport: txTransport }),
    keys,
    zipAddress: zipAddressKeys(keys.masterSecret),
    semaphore: new Identity(`${cfg.seed}/${c.id}/semaphore`),
  };
}
export type Who = ReturnType<typeof identityOf>;
export const people = new Map(CAST.map((c) => [c.id, identityOf(c)]));

// ---------------------------------------------------------------------------------------------------------------
// the world log: every action with full detail (job ids, hashes, amounts). PRIVATE: local state only, never served.
// What the public sees is the story (story.ts): coarsened, and told after an independent random delay.
// ---------------------------------------------------------------------------------------------------------------

const LOG = path.join(cfg.dataDir, "world.jsonl");
/** Recent private records (the minds read these for context; they are never served) */
export const events: Happened[] = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-50).map((l) => JSON.parse(l))
  : [];

export const story = new Story({
  names: new Map(CAST.map((c) => [c.id, c.name])),
  delayMinMin: cfg.storyDelayMin,
  delayMaxMin: cfg.storyDelayMax,
  dir: cfg.dataDir,
});

export function record(e: Omit<Happened, "at">) {
  const ev: Happened = { at: Date.now(), ...e };
  fs.appendFileSync(LOG, JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  events.push(ev);
  if (events.length > 50) events.shift();
  story.add(ev);
  console.log(`[veridia] ${ev.who}: ${ev.line}`);
  return ev;
}

// ---------------------------------------------------------------------------------------------------------------
// persistent facts (merchant ids, badge locks) so bootstrap is idempotent
// ---------------------------------------------------------------------------------------------------------------

const FACTS = path.join(cfg.dataDir, "facts.json");
export const facts: {
  merchantId: Record<string, string>;
  badged: string[];
  funded: string[];
  /** Private savings the treasury still has to deposit for a resident (wei as strings); gone once seeded */
  seed: Record<string, { target: string; done: string }>;
  voted: Record<string, string[]>;
  /** Zip links each resident holds (savings deposited by the treasury), as decimal nullifier/secret */
  links: Record<string, { n: string; s: string }[]>;
  /** "day:group:slot" ZipSignal post slots each resident has used today (one post per slot, see slots.ts) */
  posted: Record<string, string[]>;
  /** Hashes of the anonymous polls residents asked (so they answer those, and never real users' polls) */
  asked: Hex[];
} = {
  merchantId: {},
  badged: [],
  funded: [],
  seed: {},
  voted: {},
  links: {},
  posted: {},
  asked: [],
  ...(fs.existsSync(FACTS) ? JSON.parse(fs.readFileSync(FACTS, "utf8")) : {}),
};
export const saveFacts = () => fs.writeFileSync(FACTS, JSON.stringify(facts, null, 1));
