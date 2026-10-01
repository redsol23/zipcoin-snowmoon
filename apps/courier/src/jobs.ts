import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";

import {
  batchRelayerAbi,
  decodeBatchRelay,
  entrypointAbi,
  bandsAbi,
  harvestAbi,
  harvestTargets,
  insertGasHeadroom,
  jobHashOf,
  keyAccepted,
  signReceipt as signReceiptWith,
  payloadCourier,
  poolAbi,
  proofSignals,
  signingKeys,
  zipBadgesAbi,
  zipBroadcasterAbi,
  zipDoorstepAbi,
  zipPayAbi,
  zipPollsAbi,
  zipRezipAbi,
  zipSignalAbi,
  type ProcessooorKind,
  type SignedReceipt,
  type SolidityProof,
  treeDepthOf,
} from "@zipnet/sdk";

import { cfg, fees, pub, schedule, sender } from "./config";
import { recentRoots, state } from "./state";
import { aspPublishPending, InsertRate, lateHeldPoolProof, poolRootPressed } from "./roots";
import { JobStore } from "./jobstore";
import { PAYOUT_GAS, PAYOUT_KINDS, payoutTarget, type PayoutKind } from "./payouts";
import { FreeBudget } from "./budget";
import { isDue, failureKind, MAX_ATTEMPTS, retryDelayMs, sendBy } from "./schedule";
import { errorText, TxDropped } from "./sender";

/**
 * Jobs a courier carries: a spend proof for one of the processooors (fee-paying), or a Semaphore post or vote (free,
 * rate-limited). A job can be sent now or held and sent at a random moment before the ASP epoch ends; held relay, batch and rezip jobs get
 * a signed Receipt the user can take to ZipCouriers.report if we fail to deliver.
 *
 * "batch" jobs go through the upstream BatchRelayer: several of one person's notes, one recipient, one transaction.
 * All proofs share one withdrawal (same recipient and total), so they can only come from the same person; batching
 * does link those notes to each other, which the wallet says before offering it.
 */

export type Kind = ProcessooorKind | FreeKind | "batch";

/** Jobs that carry a Semaphore proof, a signed authorisation (parked-payout recovery, payouts.ts) or a public call instead of a note spend: no fee, rate-limited */
export type FreeKind = "post" | "vote" | "unlock" | "harvest" | "claimEth" | BandsKind | PayoutKind;
export const FREE: ReadonlySet<Kind> = new Set<Kind>(["post", "vote", "unlock", "harvest", "claimEth", "bands", "bandsCollect", "bandsClaim", "bandsForward", ...PAYOUT_KINDS]);
/** The liquidity bands' permissionless calls (bands.ts): the courier's own jobs only, never accepted from a client */
export type BandsKind = "bands" | "bandsCollect" | "bandsClaim" | "bandsForward";
const BANDS: ReadonlySet<Kind> = new Set<Kind>(["bands", "bandsCollect", "bandsClaim", "bandsForward"]);
const NONE = "0x0000000000000000000000000000000000000000" as Address;

export type Job = {
  id: string;
  kind: Kind;
  withdrawal?: { processooor: Address; data: Hex };
  proof?: SolidityProof<8>;
  /** batch jobs: one proof per note */
  proofs?: SolidityProof<8>[];
  /** Semaphore relays: the call's arguments */
  args?: unknown[];
  submitAt: number;
  deadline: number;
  /** "sending" is saved before the transaction goes out, so a restart checks the chain instead of sending twice */
  status: "held" | "sending" | "sent" | "failed";
  tx?: Hex;
  error?: string;
  /** Held relay, batch and rezip jobs (RECEIPTED): the signed promise, with the exact call a report would deliver */
  receipt?: SignedReceipt;
  /** Failed sends retried so far (M-2) */
  attempts?: number;
  /** The courier's own traffic (cover, harvests): sent after users' jobs when both are waiting */
  own?: boolean;
  /** When it reached sent or failed (unix ms; jobstore.ts): pruned JOBS_RETENTION_DAYS after */
  doneAt?: number;
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
  /** per proof in the batch */
  batch: 650_000n,
  /** harvest() on a ZC-holding contract: claim from ZC, then book or forward the ETH (about 112k measured) */
  harvest: 150_000n,
  /** ZipBadges.claimEthFor(rewardTo): pays a badge's unlinked reward address, which has no gas of its own */
  claimEth: 150_000n,
  /** ZipLiquidityBands.deposit() (ZC only): about 0.97M measured for a first deposit minting all three bands (0.47M for U1) */
  bands: 1_100_000n,
  /** collect(band): about 123k measured with fees to pay out */
  bandsCollect: 150_000n,
  /** claimRewards(): claim from ZC, all the ETH to the Safe (about 90k measured) */
  bandsClaim: 120_000n,
  /** forwardEth(): all the ETH the bands contract holds to the Safe (about 34k measured) */
  bandsForward: 60_000n,
  /** Parked-payout recovery (payouts.ts): redirect, release or ragequit on ZipBadges */
  ...PAYOUT_GAS,
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
  batch: { address: (dep.batchRelayer ?? "0x0000000000000000000000000000000000000000") as Address, abi: batchRelayerAbi as Abi, fn: "batchRelay" },
  /** args: [contract], one of harvestTargets(dep) (checked in accept) */
  harvest: { address: dep.pool, abi: harvestAbi as Abi, fn: "harvest" },
  claimEth: { address: dep.badges, abi: zipBadgesAbi as Abi, fn: "claimEthFor" },
  bands: { address: dep.bands ?? NONE, abi: bandsAbi as Abi, fn: "deposit" },
  /** args: [band] */
  bandsCollect: { address: dep.bands ?? NONE, abi: bandsAbi as Abi, fn: "collect" },
  bandsClaim: { address: dep.bands ?? NONE, abi: bandsAbi as Abi, fn: "claimRewards" },
  bandsForward: { address: dep.bands ?? NONE, abi: bandsAbi as Abi, fn: "forwardEth" },
  ...payoutTargets(),
};

/** The payout-recovery kinds call this deployment's own ZipBadges (args checked in relay.ts) */
function payoutTargets() {
  const on = { badges: { address: dep.badges, abi: zipBadgesAbi as Abi } };
  return Object.fromEntries(
    PAYOUT_KINDS.map((k) => {
      const t = payoutTarget(k);
      return [k, { ...on[t.contract], fn: t.fn }];
    }),
  ) as Record<PayoutKind, { address: Address; abi: Abi; fn: string }>;
}

const call = (j: Job) => {
  const t = TARGET[j.kind];
  if (j.kind === "harvest") return { address: j.args![0] as Address, abi: t.abi, functionName: t.fn, args: [], account: cfg.account, chain: null } as const;
  const args =
    FREE.has(j.kind)
      ? j.args!
      : j.kind === "relay"
        ? [j.withdrawal, j.proof, dep.scope]
        : j.kind === "batch"
          ? [dep.pool, j.withdrawal, j.proofs]
          : [j.withdrawal, j.proof];
  return { address: t.address, abi: t.abi, functionName: t.fn, args, account: cfg.account, chain: null } as const;
};

// ---------------------------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------------------------

/** jobs.json + its append log (jobstore.ts): a change appends the changed jobs only, ended jobs are pruned */
const store = new JobStore<Job>(cfg.dataDir, { retentionMs: cfg.jobsRetentionDays * 86_400_000, log: (m) => console.error(`[courier] ${m}`) });
export const jobs: Map<string, Job> = store.jobs;
/** On disk (fsynced) before it returns: call it with every job changed, before anything is said about them */
const save = (...js: Job[]) => store.save(...js);

/** Drops jobs that ended more than JOBS_RETENTION_DAYS ago (main.ts, hourly) */
export function pruneJobs() {
  const n = store.prune();
  if (n) console.log(`[courier] pruned ${n} jobs that ended over ${cfg.jobsRetentionDays} days ago`);
}

// ---------------------------------------------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------------------------------------------

/** The fee to quote for a job now (fees.ts: gas × gas price × margin in ZC, at least MIN_FEE_WEI), and until when it holds */
export async function quote(kind: Kind, proofs = 1) {
  return fees.quote(GAS[kind] * BigInt(proofs));
}

/** The least fee accepted now: the lowest quote still honoured, so a job made against a recent quote isn't refused */
const minFee = (kind: Kind, proofs = 1) => fees.minAccepted(GAS[kind] * BigInt(proofs));

export class Reject extends Error {}

async function checkFee(kind: Kind, withdrawal: { processooor: Address; data: Hex }, proof: SolidityProof<8>, proofCount = 1) {
  if (FREE.has(kind)) return;
  if (withdrawal.processooor.toLowerCase() !== TARGET[kind].address.toLowerCase()) throw new Reject("processooor does not match job kind");
  if (kind === "batch") {
    const b = decodeBatchRelay(withdrawal.data);
    if (b.feeRecipient.toLowerCase() !== cfg.account.address.toLowerCase()) throw new Reject("fee is not addressed to this courier");
    const min = await minFee("batch", proofCount);
    if ((b.totalValue * b.relayFeeBPS) / 10_000n < min) throw new Reject("fee below quote for this batch");
    return;
  }
  const c = payloadCourier(kind as ProcessooorKind, withdrawal.data);
  if (c.feeRecipient.toLowerCase() !== cfg.account.address.toLowerCase()) throw new Reject("fee is not addressed to this courier");
  const value = proofSignals(proof.pubSignals).value;
  const fee = kind === "relay" ? (value * c.fee) / 10_000n : c.fee; // relays carry a BPS, the rest an amount
  const min = await minFee(kind);
  if (fee < min) throw new Reject(`fee ${fee} below quote ${min}`);
}

// ---------------------------------------------------------------------------------------------------------------
// epochs + receipts
// ---------------------------------------------------------------------------------------------------------------

let epochSec = 14_400;
let epochSecAt = 0;
export async function epochEnd() {
  // The epoch length rarely changes, and /asp carries every approved label: asked every 10 minutes, not on every job
  if (Date.now() - epochSecAt > 600_000) {
    try {
      const r = (await (await fetch(`${cfg.postmanUrl}/asp`)).json()) as { epochSec: number };
      epochSec = r.epochSec;
      epochSecAt = Date.now();
    } catch {
      /* keep the last known epoch length */
    }
  }
  const now = Math.floor(Date.now() / 1000);
  return (Math.floor(now / epochSec) + 1) * epochSec;
}

/**
 * Whether the postman is about to replace the ASP root every pool proof must name (roots.ts, aspPublishPending):
 * asked of the postman's /health (lastEpoch) first, and only in the seconds after an epoch turns of /asp and the chain.
 * If the postman can't be asked, nothing is refused on its account.
 */
async function aspPublishDue() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const h = (await (await fetch(`${cfg.postmanUrl}/health`)).json()) as { lastEpoch?: number };
    if (typeof h.lastEpoch !== "number" || h.lastEpoch >= Math.floor(now / epochSec)) return false;
    const [a, onchainRoot] = await Promise.all([
      fetch(`${cfg.postmanUrl}/asp`).then((r) => r.json() as Promise<{ root: string; epochSec: number }>),
      pub.readContract({ address: dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" }) as Promise<bigint>,
    ]);
    return aspPublishPending({ now, epochSec: a.epochSec, lastEpoch: h.lastEpoch, postmanRoot: BigInt(a.root), onchainRoot });
  } catch {
    return false;
  }
}

/**
 * Whether ZipCouriers accepts our receipt key (RECEIPT_KEY, or COURIER_KEY) as this courier's signing key. Until it
 * does, held jobs are refused: a receipt the contract wouldn't accept is a promise the user can't enforce.
 */
let receiptKeyOk = false;
export async function checkReceiptKey() {
  const keys = await signingKeys(pub, dep.couriers, { courier: cfg.account.address });
  receiptKeyOk = keyAccepted(keys, cfg.receiptAccount.address);
  if (!receiptKeyOk) console.error(`[courier] ZipCouriers doesn't accept ${cfg.receiptAccount.address} as this courier's receipt key (it has ${keys.key}); held jobs are refused until it does`);
  return receiptKeyOk;
}

/**
 * Kinds a held job gets a delivery receipt for (review 2 H-1). ZipCouriers.report delivers the promised job itself and
 * slashes only if that succeeds, so a user who makes its own job fail can't slash. What is left is a job whose failure
 * the user can switch on while we try and off again when it reports; these kinds have no such switch: a relay's
 * recipient and fee are bound and only the Entrypoint owner can change its limits, a batch (relays to one recipient)
 * fails for good once any of its notes is spent, and a rezip's only user-side failure (a used precommitment) is
 * permanent too. Other kinds can still be held, but without a receipt.
 */
export const RECEIPTED: ReadonlySet<Kind> = new Set<Kind>(["relay", "batch", "rezip"]);

/** The receipt for a job: its exact call (target + calldata, bound by jobHash), the note it spends, and the deadline */
async function signReceipt(job: Job, proof: SolidityProof<8>, deadline: number): Promise<SignedReceipt> {
  const c = call(job);
  const callData = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args } as never);
  const message = {
    courier: cfg.account.address,
    nullifierHash: proofSignals(proof.pubSignals).nullifierHash,
    jobHash: jobHashOf(c.address, callData),
    deadline: BigInt(deadline),
  };
  const signature = await signReceiptWith(cfg.receiptAccount, dep.couriers, dep.chainId, message);
  return { message, signature, target: c.address, callData };
}

/** A note we already hold a receipted job for: one receipt per nullifier (a slash spends it, so more would add nothing) */
const receiptedNullifier = (nullifierHash: bigint) =>
  [...jobs.values()].some((j) => j.receipt && (j.status === "held" || j.status === "sending") && BigInt(j.receipt.message.nullifierHash) === nullifierHash);

// ---------------------------------------------------------------------------------------------------------------
// accept + deliver
// ---------------------------------------------------------------------------------------------------------------

/** Free kinds that can't wait for tomorrow: a parked payout is someone's money */
export const CRITICAL: ReadonlySet<Kind> = new Set<Kind>([...PAYOUT_KINDS]);

/** The free-relay budget (budget.ts, review 2 M-3): counted after simulation, per client, per kind, with a reserve */
export const freeBudget = new FreeBudget({
  perDay: cfg.freeRelaysPerDay,
  reservedShare: cfg.freeReservedShare,
  kindShare: cfg.freeKindShare,
  perClientPerHour: cfg.freePerClientPerHour,
  critical: CRITICAL,
});

/**
 * Validates, simulates and either sends or holds a job.
 * @param holdSec 0 = send now; otherwise send at a uniformly random time within min(holdSec, rest of epoch)
 * @param own the courier's own traffic (cover, harvests, bands): no fee owed, and not a free relay
 * @param client who asked (the client IP, or the first hop for a sealed job), for the per-client free-job limit;
 *   null when there is no address worth limiting
 */
export async function accept(req: Omit<Job, "id" | "submitAt" | "deadline" | "status">, holdSec: number, own = false, client: string | null = null) {
  // Paid for out of the free budget: a free kind someone else asked for. The courier's own jobs never count.
  const free = FREE.has(req.kind) && !own;
  if (FREE.has(req.kind)) {
    if (BANDS.has(req.kind) && (!own || !dep.bands)) throw new Reject("liquidity bands jobs are the courier's own");
    if (req.kind === "harvest" && !harvestTargets(dep).some((a) => a.toLowerCase() === String(req.args?.[0]).toLowerCase())) throw new Reject("not a harvestable contract");
    const refused = free ? freeBudget.admit(req.kind, client) : null;
    if (refused) throw new Reject(refused);
  } else if (req.kind === "batch") {
    if (!dep.batchRelayer) throw new Reject("batch relaying isn't deployed here");
    if (!req.withdrawal || !req.proofs || req.proofs.length < 1 || req.proofs.length > 10) throw new Reject("a batch needs a withdrawal and 1 to 10 proofs");
    if (!own) await checkFee("batch", req.withdrawal, req.proofs[0], req.proofs.length);
  } else {
    if (!req.withdrawal || !req.proof) throw new Reject("missing withdrawal or proof");
    if (!own) await checkFee(req.kind, req.withdrawal, req.proof);
  }

  if (holdSec > 0 && RECEIPTED.has(req.kind) && !receiptKeyOk && !(await checkReceiptKey().catch(() => false))) throw new Reject("this courier can't sign enforceable receipts right now; send with holdSec 0");

  const job: Job = { ...req, id: crypto.randomUUID(), submitAt: Date.now(), deadline: 0, status: "held", ...(own ? { own: true } : {}) };
  try {
    await pub.simulateContract(call(job) as never);
  } catch (e) {
    // Keep the decoded error name, or the raw selector when the revert comes from a contract we have no ABI for
    const err = e as { shortMessage?: string; metaMessages?: string[]; message: string };
    const detail = [err.shortMessage ?? err.message.split("\n")[0], ...(err.metaMessages ?? []).map((m) => m.trim()).filter(Boolean)].join(" ");
    throw new Reject(`simulation reverted: ${detail}`);
  }
  if (free) {
    // Counted only now that it would succeed; checked again, since others may have used the room meanwhile
    const refused = freeBudget.room(job.kind);
    if (refused) throw new Reject(refused);
    freeBudget.spend(job.kind);
  }

  // A batch's receipt names its first proof's nullifier: the report can only deliver the whole batch, or nothing
  const promised = job.proof ?? job.proofs?.[0];
  // A held pool proof must still name the latest ASP root when it goes out: not so if this epoch's publish is due
  if (holdSec > 0 && promised && !own) {
    await epochEnd();
    // The wallet already reads IncorrectASPRoot's selector as "the list of cleared notes changed; try again"
    if (await aspPublishDue()) throw new Reject("the ASP root this proof names is being replaced this epoch (IncorrectASPRoot 0xa6a78244); prove again once the new root is published");
  }
  if (holdSec > 0 && promised) {
    const end = await epochEnd();
    job.deadline = end - cfg.epochMarginSec;
    // M-1: sent early enough to survive resends and the queue ahead of it; refused if that moment has already passed
    const latest = RECEIPTED.has(job.kind) ? sendBy(job.deadline, receiptedWaiting(), schedule) : job.deadline - 30;
    const now = Math.floor(Date.now() / 1000);
    if (RECEIPTED.has(job.kind) && latest <= now) {
      // Too late in the ASP epoch for a receipt: sent now without one, as the wallet would resend it (roots.ts), unless
      // the turn is so close that even a send now may land on the new root
      if (lateHeldPoolProof(now, end, cfg.aspTurnGuardSec) === "refuse") {
        throw new Reject("too close to the end of the ASP epoch to promise delivery; send it now (holdSec 0) or after the epoch turns");
      }
      job.deadline = 0;
    } else {
      const room = Math.max(0, Math.min(holdSec, latest - now));
      job.submitAt = Date.now() + Math.floor(Math.random() * room * 1000);
      if (RECEIPTED.has(job.kind)) {
        const nullifierHash = proofSignals(promised.pubSignals).nullifierHash;
        if (receiptedNullifier(nullifierHash)) throw new Reject("this note already has a held job with a receipt here");
        job.receipt = await signReceipt(job, promised, job.deadline);
      }
      // A held pool proof already close to leaving the pool's root history goes now, not at its moment (roots.ts): by
      // the next deliver tick it could be too late
      if (job.submitAt > Date.now()) {
        const pool = await poolNow();
        if (poolRootPressed(poolAges(job, pool.size), pool.rate)) job.submitAt = Date.now();
      }
    }
  }
  jobs.set(job.id, job);
  save(job);
  if (job.submitAt <= Date.now()) await deliver(job);
  return job;
}

/** Root ages (inserts since each named state root; roots.ts) of a job's pool proofs; a root we haven't seen counts as fresh */
const poolProofs = (j: Job) => j.proofs ?? (j.proof ? [j.proof] : []);
const poolAges = (j: Job, sizeNow: number) => poolProofs(j).map((p) => recentRoots.age(proofSignals(p.pubSignals).stateRoot, sizeNow) ?? 0);

/** The pool's tree size on chain and its insert rate, read at most every 2 s: fresher than the 10 s state refresh */
const insertRate = new InsertRate();
let poolSize = { at: 0, size: 0 };
async function poolNow() {
  if (Date.now() - poolSize.at >= 2000) {
    try {
      poolSize = { at: Date.now(), size: Number(await pub.readContract({ address: dep.pool, abi: poolAbi, functionName: "currentTreeSize" })) };
      insertRate.add(poolSize.at, poolSize.size);
    } catch {
      /* keep the last reading */
    }
  }
  return { size: poolSize.size, rate: insertRate.perSec() };
}

/** Jobs being sent right now: accept() and the deliverDue() loop must not both send one (the second would revert) */
const sending = new Set<string>();

/** Receipted jobs still to be sent or confirmed: each needs a send slot before its deadline */
const receiptedWaiting = () => [...jobs.values()].filter((j) => j.receipt && (j.status === "held" || j.status === "sending")).length;

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** M-2: back to "held", to be sent again after a backoff (deliverDue picks it up) */
function retryLater(job: Job, why: string) {
  job.attempts = (job.attempts ?? 0) + 1;
  job.status = "held";
  job.tx = undefined;
  job.submitAt = Date.now() + retryDelayMs(job.attempts);
  job.error = `retrying (${job.attempts}): ${why}`;
}

/**
 * A send or a check failed. A revert is final (the job can't succeed any more); anything else is retried, a receipted
 * job for as long as it takes (sent after its deadline it still spends the note, which is what stops a report), any
 * other job up to MAX_ATTEMPTS times.
 */
function onFailure(job: Job, e: unknown, prefix = "") {
  const why = `${prefix}${firstLine(e)}`;
  if (failureKind(e) === "transient" && (job.receipt || (job.attempts ?? 0) < MAX_ATTEMPTS)) return retryLater(job, why);
  job.status = "failed";
  job.error = why;
  if (job.receipt) console.error(`[courier] ALERT: receipted ${job.kind} job ${job.id.slice(0, 8)} can't be delivered: ${why}`);
}

/**
 * A job's transaction reverted on-chain. If the job would still succeed (e.g. it lost a race it can win again), it is
 * sent again; otherwise it failed for good.
 */
async function afterRevert(job: Job) {
  try {
    await pub.simulateContract({ ...(call(job) as object), blockTag: "pending" } as never);
    retryLater(job, "reverted on-chain but still simulates");
  } catch (e) {
    onFailure(job, e, "reverted on-chain: ");
  }
}

/** Waits for whichever version of the job's transaction lands (the send queue resends dropped ones; see sender.ts) */
async function confirm(job: Job, hash: Hex) {
  const r = await sender.waitForReceipt(hash);
  job.tx = r.transactionHash;
  if (r.status === "success") {
    job.status = "sent";
    job.error = undefined;
  } else await afterRevert(job);
}

/**
 * A pool spend inserts its change note into the state tree, which costs more than estimated when other inserts land
 * first in the block (sdk insertGasHeadroom): headroom over the estimate, one insert per proof.
 */
function gasExtraOf(job: Job): { gasExtra?: bigint } {
  const n = job.proofs?.length ?? (job.proof ? 1 : 0);
  return n ? { gasExtra: insertGasHeadroom(treeDepthOf(state.leaves.length + n), n) } : {};
}

async function deliver(job: Job) {
  if (sending.has(job.id)) return;
  sending.add(job.id);
  try {
    // On disk before the transaction exists, and the hash as soon as it does: see settleSending
    job.status = "sending";
    save(job);
    // Through the courier's one send queue (sender.ts), users' jobs ahead of its own cover and harvest traffic
    const hash = await sender.write(job.own ? "background" : "user", { ...call(job), ...gasExtraOf(job) });
    job.tx = hash;
    save(job);
    try {
      await confirm(job, hash);
    } catch (e) {
      // Its nonce went to another transaction: settleSending decides whether the job can be sent again
      if (!(e instanceof TxDropped)) throw e;
      job.tx = undefined;
      await settleSending(job);
    }
  } catch (e) {
    // Nothing is in flight for it unless a hash was booked: then settleSending checks before anything is resent
    if (job.tx) await settleSending(job).catch((e2) => onFailure(job, e2));
    else onFailure(job, e);
  } finally {
    sending.delete(job.id);
  }
  save(job);
  console.log(`[courier] ${job.kind} ${job.id.slice(0, 8)} ${job.status}${job.tx ? " " + job.tx : ""}${job.error ? " " + job.error : ""}`);
}

/**
 * Settles a job left "sending", by a previous run (recoverSending) or by a send whose nonce went to another
 * transaction. If the send queue still has its transaction in flight (its book survives restarts), wait for it: it may
 * yet land, and sending the job again would race it. A private relay hides pending transactions, so "the read node
 * doesn't know this hash" never means dropped. If the read node has a receipt, that settles it. Otherwise nothing sent
 * for it can land any more: simulate again against the pending block; if it would still succeed the job goes back to
 * "held" and deliverDue sends it again, otherwise it was already delivered or can no longer be, and it is marked failed
 * rather than sent twice. A network error on the way is retried, never taken as a failure (M-2).
 */
async function settleSending(job: Job) {
  if (job.tx) {
    if (sender.tracks(job.tx)) {
      try {
        await confirm(job, job.tx);
        return;
      } catch (e) {
        if (!(e instanceof TxDropped)) {
          onFailure(job, e);
          return;
        }
      }
    } else {
      let r: Awaited<ReturnType<typeof pub.getTransactionReceipt>> | null = null;
      try {
        r = await pub.getTransactionReceipt({ hash: job.tx });
      } catch (e) {
        // "not found" means it never landed; a network error means we don't know yet: keep it "sending" for later
        if (!/TransactionReceiptNotFoundError|could not be found/i.test(errorText(e))) {
          job.error = `checking ${job.tx}: ${firstLine(e)}`;
          return;
        }
      }
      if (r) {
        if (r.status === "success") job.status = "sent";
        else await afterRevert(job);
        return;
      }
    }
  }
  try {
    await pub.simulateContract({ ...(call(job) as object), blockTag: "pending" } as never);
    job.status = "held";
    job.tx = undefined;
  } catch (e) {
    onFailure(job, e, "not resent: ");
  }
}

/** Settles one job left "sending" with nobody working on it */
async function resettle(job: Job) {
  if (sending.has(job.id)) return;
  sending.add(job.id);
  try {
    await settleSending(job);
  } catch (e) {
    onFailure(job, e);
  } finally {
    sending.delete(job.id);
  }
  save(job);
  console.log(`[courier] recovered ${job.kind} ${job.id.slice(0, 8)} ${job.status}${job.tx ? " " + job.tx : ""}`);
}

/** On startup (and on every deliverDue pass), settles the jobs left "sending" with nobody working on them. */
export async function recoverSending() {
  for (const job of jobs.values()) if (job.status === "sending") await resettle(job);
}

/**
 * Sends every due held job at once (M-1): each goes into the send queue now and its receipt is awaited on its own, so
 * one slow inclusion never holds up the rest. Receipted jobs running short of time go now even before their random
 * moment, earliest deadline first.
 */
export async function deliverDue() {
  const depth = receiptedWaiting() + sender.queued.user;
  const pool = [...jobs.values()].some((j) => j.status === "held" && poolProofs(j).length) ? await poolNow() : null;
  const aging = (j: Job) => !!pool && poolRootPressed(poolAges(j, pool.size), pool.rate);
  const due = [...jobs.values()]
    .filter((j) => j.status === "held" && !sending.has(j.id) && (isDue(j, Date.now(), depth, schedule) || aging(j)))
    .sort((a, b) => Number(!a.receipt) - Number(!b.receipt) || a.deadline - b.deadline);
  for (const j of due) void deliver(j);
  // A job left "sending" because its status couldn't be read (a network error) is looked at again
  for (const j of jobs.values()) if (j.status === "sending" && !sending.has(j.id)) void resettle(j);
}
