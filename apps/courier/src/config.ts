import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, hexToBytes, http, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bandsAbi, envelopeKeys, parseDeployment } from "@zipnet/sdk";

import { Fees, zcPerEthFromSqrt } from "./fees";
import { chainIo } from "./io";
import { Sender } from "./sender";
import { atomicWrite } from "./files";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const cfg = {
  /** Reads: state, simulations, gas estimates, receipts, nonces (the "latest" count) */
  rpcUrl: env("RPC_URL"),
  /**
   * Writes: where signed transactions go (eth_sendRawTransaction only). Should be a private relay on mainnet
   * (docs/DEPLOY.md, "Private mempool"): relayed proofs are valid for whoever lands them first. Unset = RPC_URL.
   */
  sendRpcUrl: process.env.SEND_RPC_URL || env("RPC_URL"),
  dep: parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8")),
  account: privateKeyToAccount(env("COURIER_KEY") as Hex),
  /**
   * The EOA key delivery receipts are signed with (ZipCouriers checks them with plain ECDSA only). Unset = COURIER_KEY.
   * A separate key is registered on the first bond (`bondWithKey`); to change it later, call `rotateSigningKey` and
   * keep the old key's receipts honoured: the contract accepts the old key for evidence for a while after.
   */
  receiptAccount: privateKeyToAccount((process.env.RECEIPT_KEY || env("COURIER_KEY")) as Hex),
  postmanUrl: env("POSTMAN_URL", "http://127.0.0.1:8710"),
  port: Number(env("PORT", "8720")),
  publicUrl: env("PUBLIC_URL", `http://127.0.0.1:${env("PORT", "8720")}`),
  dataDir: env("DATA_DIR", path.resolve(".courier")),
  /** Days a job that ended (sent or failed) stays in jobs.json and on /jobs/:id before it is dropped */
  jobsRetentionDays: Number(env("JOBS_RETENTION_DAYS", "7")),
  /** ZC to bond on first start if not yet bonded (0 = don't bond) */
  bond: BigInt(env("BOND_WEI", "0")),
  /** Fees (fees.ts). A fixed ZC per ETH (wad) that overrides the pool price; unset/0 = the pool's median price */
  zcPerEthWad: BigInt(env("ZC_PER_ETH_WAD", "0")),
  /** Floor under every fee quote, ZC wei. Required on a real chain (checked below). */
  minFeeWei: BigInt(env("MIN_FEE_WEI", "0")),
  feeMarginBps: BigInt(env("FEE_MARGIN_BPS", "2000")),
  feeSampleSec: Number(env("FEE_SAMPLE_SEC", "60")),
  feeTwapSec: Number(env("FEE_TWAP_SEC", "1800")),
  feeMinSamples: Number(env("FEE_MIN_SAMPLES", "5")),
  quoteRefreshSec: Number(env("QUOTE_REFRESH_SEC", "60")),
  quoteValidSec: Number(env("QUOTE_VALID_SEC", "600")),
  /** Seconds before an ASP epoch ends by which held proofs must be on-chain */
  epochMarginSec: Number(env("EPOCH_MARGIN_SEC", "120")),
  /**
   * A held pool proof too late in its ASP epoch for a receipt is sent at once instead (roots.ts lateHeldPoolProof),
   * unless the epoch ends within this many seconds (about a block): then even a send now may land on the new root
   */
  aspTurnGuardSec: Number(env("ASP_TURN_GUARD_SEC", "12")),
  /** Cover traffic: expected actions per hour (0 = off) and daily gas budget in wei */
  coverPerHour: Number(env("COVER_PER_HOUR", "0")),
  coverDailyGasWei: BigInt(env("COVER_DAILY_GAS_WEI", "50000000000000000")),
  coverMnemonic: process.env.COVER_MNEMONIC,
  /** Semaphore relays (posts, votes) carry no fee; cap how many we pay gas for per day */
  freeRelaysPerDay: Number(env("FREE_RELAYS_PER_DAY", "500")),
  /** Share of the free budget only parked-payout recovery may use (budget.ts) */
  freeReservedShare: Number(env("FREE_RESERVED_SHARE", "0.2")),
  /** Most of the free budget one other kind (votes, posts, ...) may use in a day */
  freeKindShare: Number(env("FREE_KIND_SHARE", "0.5")),
  /** Free-job attempts one client (IP, or first hop for sealed jobs) may make per hour; 0 = no limit */
  freePerClientPerHour: Number(env("FREE_PER_CLIENT_PER_HOUR", "60")),
  /** Behind a proxy or tunnel: take the client address from X-Forwarded-For (its last entry) */
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ""),
  /** Harvest a contract's ZC holder rewards (ETH) once this much is pending; unset = the harvest gas cost plus FEE_MARGIN_BPS */
  harvestMinWei: process.env.HARVEST_MIN_WEI ? BigInt(process.env.HARVEST_MIN_WEI) : undefined,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  /** Relay-hop requests one client IP may make per minute */
  hopsPerMinute: Number(env("HOPS_PER_MINUTE", "30")),
};

/** Chains where a zero fee is allowed (a local anvil); anywhere else a fee floor and a price source are required */
const LOCAL_CHAINS = new Set([31337]);
const local = LOCAL_CHAINS.has(cfg.dep.chainId);

/**
 * Held-job delivery (schedule.ts, review 2 M-1): a receipted job is sent at least DELIVER_MARGIN_SEC before its
 * deadline (default 300: more than two resend intervals), plus SEND_SLOT_SEC per receipted job waiting ahead of it.
 * A local chain's short test epochs use a few seconds.
 */
export const schedule = {
  marginSec: Number(env("DELIVER_MARGIN_SEC", local ? "5" : "300")),
  slotSec: Number(env("SEND_SLOT_SEC", local ? "0" : "3")),
};

/** This courier's envelope key (published at /quote): clients seal jobs to it and send them through another courier. */
export const envelope = envelopeKeys(hexToBytes(env("COURIER_KEY") as Hex));

export const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
/** Only ever asked to broadcast: nonces, estimates and receipts come from the read node */
const sendPub = createPublicClient({ transport: http(cfg.sendRpcUrl) });
const wallet = createWalletClient({ account: cfg.account, transport: http(cfg.rpcUrl) });

fs.mkdirSync(cfg.dataDir, { recursive: true });
const SENDER_FILE = path.join(cfg.dataDir, "sender.json");

/** Every transaction this courier signs goes through here (see sender.ts); never call wallet.writeContract directly */
export const sender = new Sender<TransactionReceipt>({
  io: chainIo({ pub, wallet, sendPub, chainId: cfg.dep.chainId }),
  store: { load: () => (fs.existsSync(SENDER_FILE) ? fs.readFileSync(SENDER_FILE, "utf8") : null), save: (d) => atomicWrite(SENDER_FILE, d) },
  resendAfterMs: Number(env("RESEND_AFTER_SEC", "120")) * 1000,
  abandonAfterMs: Number(env("ABANDON_AFTER_SEC", "600")) * 1000,
});
sender.start();

if (!local) {
  if (cfg.minFeeWei === 0n) throw new Error("MIN_FEE_WEI is required on this chain: the floor under every fee quote, in ZC wei (docs/DEPLOY.md, courier fees)");
  if (cfg.zcPerEthWad === 0n && !cfg.dep.bands) throw new Error("no ZC price for fees: set ZC_PER_ETH_WAD, or deploy ZipLiquidityBands so the pool price can be read");
}

const FEE_SAMPLES_FILE = path.join(cfg.dataDir, "fee-samples.json");
const bands = cfg.dep.bands;

/** Fee quotes (fees.ts): gas × gas price × margin, priced in ZC at the pool's median price or ZC_PER_ETH_WAD */
export const fees = new Fees({
  gasPrice: () => pub.getGasPrice(),
  spotZcPerEthWad: bands
    ? async () => zcPerEthFromSqrt(((await pub.readContract({ address: bands, abi: bandsAbi, functionName: "slot0" })) as readonly [bigint, number])[0])
    : undefined,
  fixedZcPerEthWad: cfg.zcPerEthWad,
  minFeeWei: cfg.minFeeWei,
  marginBps: cfg.feeMarginBps,
  sampleSec: cfg.feeSampleSec,
  twapSec: cfg.feeTwapSec,
  minSamples: cfg.feeMinSamples,
  refreshSec: cfg.quoteRefreshSec,
  validSec: cfg.quoteValidSec,
  store: { load: () => (fs.existsSync(FEE_SAMPLES_FILE) ? fs.readFileSync(FEE_SAMPLES_FILE, "utf8") : null), save: (d) => atomicWrite(FEE_SAMPLES_FILE, d) },
  log: (m) => console.warn(`[fees] ${m}`),
});

