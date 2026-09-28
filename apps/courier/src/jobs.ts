import fs from "node:fs";
import path from "node:path";
import type { Abi, Address, Hex } from "viem";

import {
  entrypointAbi,
  payloadCourier,
  proofSignals,
  zipBadgesAbi,
  zipBroadcasterAbi,
  zipDoorstepAbi,
  zipPayAbi,
  zipPollsAbi,
  zipRezipAbi,
  zipSignalAbi,
  type ProcessooorKind,
  type SolidityProof,
} from "@zipnet/sdk";

import { cfg, pub, wallet } from "./config";

/**
 * Jobs a courier carries: a spend proof for one of the processooors (fee-paying), or a Semaphore post/vote (free,
 * rate-limited). A job can be sent now or held and sent at a random moment before the ASP epoch ends; held jobs get
 * a signed Receipt the user can take to ZipCouriers.report if we fail to deliver.
 */

export type Kind = ProcessooorKind | "post" | "vote" | "unlock";

export type Job = {
  id: string;
  kind: Kind;
  withdrawal?: { processooor: Address; data: Hex };
  proof?: SolidityProof<8>;
  /** Semaphore relays: the call's arguments */
  args?: unknown[];
  submitAt: number;
  deadline: number;
  status: "held" | "sent" | "failed";
  tx?: Hex;
  error?: string;
  receipt?: { message: Record<string, unknown>; signature: Hex };
};

const { dep } = cfg;

/** Gas each call uses (measured in the Foundry suite, plus headroom); drives fee quotes and the cover budget. */
export const GAS: Record<Kind, bigint> = {
  relay: 650_000n,
  speak: 700_000n,
  knock: 720_000n,
  rezip: 900_000n,
  pay: 900_000n,
  lock: 1_000_000n,
  poll: 800_000n,
  post: 350_000n,
  vote: 400_000n,
  unlock: 600_000n,
};

const TARGET: Record<Kind, { address: Address; abi: Abi; fn: string }> = {
  relay: { address: dep.entrypoint, abi: entrypointAbi as Abi, fn: "relay" },
  speak: { address: dep.broadcaster, abi: zipBroadcasterAbi as Abi, fn: "speakAnon" },
  knock: { address: dep.doorstep, abi: zipDoorstepAbi as Abi, fn: "knockAnon" },
  rezip: { address: dep.rezip, abi: zipRezipAbi as Abi, fn: "rezip" },
  pay: { address: dep.pay, abi: zipPayAbi as Abi, fn: "payAnon" },
  lock: { address: dep.badges, abi: zipBadgesAbi as Abi, fn: "lockAnon" },
  poll: { address: dep.polls, abi: zipPollsAbi as Abi, fn: "createAnon" },
  post: { address: dep.signal, abi: zipSignalAbi as Abi, fn: "post" },
  vote: { address: dep.polls, abi: zipPollsAbi as Abi, fn: "vote" },
  unlock: { address: dep.badges, abi: zipBadgesAbi as Abi, fn: "unlock" },
};

const call = (j: Job) => {
  const t = TARGET[j.kind];
  const args =
    j.kind === "post" || j.kind === "vote" || j.kind === "unlock"
      ? j.args!
      : j.kind === "relay"
        ? [j.withdrawal, j.proof, dep.scope]
        : [j.withdrawal, j.proof];
  return { address: t.address, abi: t.abi, functionName: t.fn, args, account: cfg.account, chain: null } as const;
};

// ---------------------------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------------------------

const FILE = path.join(cfg.dataDir, "jobs.json");
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (_k: string, v: unknown) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
export const jobs: Map<string, Job> = new Map(
  fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, "utf8"), unbig) as Job[]).map((j) => [j.id, j]) : [],
);
const save = () => fs.writeFileSync(FILE, JSON.stringify([...jobs.values()], big));

// ---------------------------------------------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------------------------------------------

export async function quote(kind: Kind) {
  const gasPrice = await pub.getGasPrice();
  const costWei = (GAS[kind] * gasPrice * (10_000n + cfg.feeMarginBps)) / 10_000n;
  const fromGas = cfg.zcPerEthWad === 0n ? 0n : (costWei * cfg.zcPerEthWad) / 10n ** 18n;
  return fromGas > cfg.minFeeWei ? fromGas : cfg.minFeeWei;
}

export class Reject extends Error {}

async function checkFee(kind: Kind, withdrawal: { processooor: Address; data: Hex }, proof: SolidityProof<8>) {
  if (kind === "post" || kind === "vote" || kind === "unlock") return;
  if (withdrawal.processooor.toLowerCase() !== TARGET[kind].address.toLowerCase()) throw new Reject("processooor does not match job kind");
  const c = payloadCourier(kind as ProcessooorKind, withdrawal.data);
  if (c.feeRecipient.toLowerCase() !== cfg.account.address.toLowerCase()) throw new Reject("fee is not addressed to this courier");
  const value = proofSignals(proof.pubSignals).value;
  const fee = kind === "relay" ? (value * c.fee) / 10_000n : c.fee; // relays carry a BPS, the rest an amount
  const min = await quote(kind);
  if (fee < min) throw new Reject(`fee ${fee} below quote ${min}`);
}

// ---------------------------------------------------------------------------------------------------------------
// epochs + receipts
// ---------------------------------------------------------------------------------------------------------------

let epochSec = 14_400;
export async function epochEnd() {
  try {
    const r = (await (await fetch(`${cfg.postmanUrl}/asp`)).json()) as { epochSec: number };
    epochSec = r.epochSec;
  } catch {
    /* keep the last known epoch length */
  }
  const now = Math.floor(Date.now() / 1000);
  return (Math.floor(now / epochSec) + 1) * epochSec;
}

async function signReceipt(proof: SolidityProof<8>, deadline: number) {
  const s = proofSignals(proof.pubSignals);
  const message = {
    courier: cfg.account.address,
    nullifierHash: s.nullifierHash,
    aspRoot: s.aspRoot,
    stateRoot: s.stateRoot,
    deadline: BigInt(deadline),
  };
  const signature = await cfg.account.signTypedData({
    domain: { name: "zipnet couriers", version: "1", chainId: dep.chainId, verifyingContract: dep.couriers },
    types: {
      Receipt: [
        { name: "courier", type: "address" },
        { name: "nullifierHash", type: "uint256" },
        { name: "aspRoot", type: "uint256" },
        { name: "stateRoot", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "Receipt",
    message,
  });
  return { message, signature };
}

// ---------------------------------------------------------------------------------------------------------------
// accept + deliver
// ---------------------------------------------------------------------------------------------------------------

const freeUsed = { day: 0, n: 0 };

/**
 * Validates, simulates and either sends or holds a job.
 * @param holdSec 0 = send now; otherwise send at a uniformly random time within min(holdSec, rest of epoch)
 * @param own the courier's own cover traffic: no fee owed
 */
export async function accept(req: Omit<Job, "id" | "submitAt" | "deadline" | "status">, holdSec: number, own = false) {
  if (req.kind === "post" || req.kind === "vote" || req.kind === "unlock") {
    const day = Math.floor(Date.now() / 86_400_000);
    if (freeUsed.day !== day) Object.assign(freeUsed, { day, n: 0 });
    if (++freeUsed.n > cfg.freeRelaysPerDay) throw new Reject("free relay budget used up for today");
  } else {
    if (!req.withdrawal || !req.proof) throw new Reject("missing withdrawal or proof");
    if (!own) await checkFee(req.kind, req.withdrawal, req.proof);
  }

  const job: Job = { ...req, id: crypto.randomUUID(), submitAt: Date.now(), deadline: 0, status: "held" };
  try {
    await pub.simulateContract(call(job) as never);
  } catch (e) {
    throw new Reject(`simulation reverted: ${(e as Error).message.split("\n")[0]}`);
  }

  if (holdSec > 0 && job.proof) {
    const end = await epochEnd();
    job.deadline = end - cfg.epochMarginSec;
    const room = Math.max(0, Math.min(holdSec, job.deadline - Math.floor(Date.now() / 1000) - 30));
    job.submitAt = Date.now() + Math.floor(Math.random() * room * 1000);
    job.receipt = await signReceipt(job.proof, job.deadline);
  }
  jobs.set(job.id, job);
  save();
  if (job.submitAt <= Date.now()) await deliver(job);
  return job;
}

async function deliver(job: Job) {
  try {
    const hash = await wallet.writeContract(call(job) as never);
    job.tx = hash;
    const r = await pub.waitForTransactionReceipt({ hash });
    job.status = r.status === "success" ? "sent" : "failed";
    if (r.status !== "success") job.error = "reverted on-chain";
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message.split("\n")[0];
  }
  save();
  console.log(`[courier] ${job.kind} ${job.id.slice(0, 8)} ${job.status}${job.tx ? " " + job.tx : ""}${job.error ? " " + job.error : ""}`);
}

export async function deliverDue() {
  for (const j of jobs.values()) if (j.status === "held" && j.submitAt <= Date.now()) await deliver(j);
}
