import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { parseDeployment } from "@zipnet/sdk";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const cfg = {
  rpcUrl: env("RPC_URL"),
  dep: parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8")),
  account: privateKeyToAccount(env("COURIER_KEY") as Hex),
  postmanUrl: env("POSTMAN_URL", "http://127.0.0.1:8710"),
  port: Number(env("PORT", "8720")),
  publicUrl: env("PUBLIC_URL", `http://127.0.0.1:${env("PORT", "8720")}`),
  dataDir: env("DATA_DIR", path.resolve(".courier")),
  /** ZC to bond on first start if not yet bonded (0 = don't bond) */
  bond: BigInt(env("BOND_WEI", "0")),
  /** ZC per ETH (wad) for fee quotes. On mainnet set from a price feed; unset = charge nothing above MIN_FEE. */
  zcPerEthWad: BigInt(env("ZC_PER_ETH_WAD", "0")),
  minFeeWei: BigInt(env("MIN_FEE_WEI", "0")),
  feeMarginBps: BigInt(env("FEE_MARGIN_BPS", "2000")),
  /** Seconds before an ASP epoch ends by which held proofs must be on-chain */
  epochMarginSec: Number(env("EPOCH_MARGIN_SEC", "120")),
  /** Cover traffic: expected actions per hour (0 = off) and daily gas budget in wei */
  coverPerHour: Number(env("COVER_PER_HOUR", "0")),
  coverDailyGasWei: BigInt(env("COVER_DAILY_GAS_WEI", "50000000000000000")),
  coverMnemonic: process.env.COVER_MNEMONIC,
  /** Semaphore relays (posts, votes) carry no fee; cap how many we pay gas for per day */
  freeRelaysPerDay: Number(env("FREE_RELAYS_PER_DAY", "500")),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
};

export const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
export const wallet = createWalletClient({ account: cfg.account, transport: http(cfg.rpcUrl) });

fs.mkdirSync(cfg.dataDir, { recursive: true });
