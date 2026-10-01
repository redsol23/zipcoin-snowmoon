import { classify, errorText } from "./sender";

/**
 * When held jobs go out, and what happens when a send fails (review 2 M-1, M-2). Pure, so it can be tested alone.
 *
 * A held job with a receipt must be on-chain before its deadline, or anyone can deliver it through ZipCouriers.report
 * and slash us. So:
 * - it is sent by `sendBy`: the deadline minus a safety margin (at least a resend interval or two, so a dropped
 *   transaction can still be resent) minus a slot per receipted job waiting ahead of it, since the send queue signs
 *   one transaction at a time;
 * - a new held job whose `sendBy` has already passed is refused rather than promised;
 * - due jobs are sent all at once through the queue's lanes, never one receipt at a time;
 * - a failed send is retried with backoff unless it was a revert (the job can't succeed any more). A network error,
 *   a rate limit or a lagging node never turns a deliverable job into a missed one.
 */

export type ScheduleOpts = {
  /** Seconds before the deadline by which a receipted job must have been sent (DELIVER_MARGIN_SEC) */
  marginSec: number;
  /** Seconds of send-queue time to allow per receipted job waiting ahead (SEND_SLOT_SEC) */
  slotSec: number;
};

/** The latest unix second a receipted job with this deadline may be sent, with `ahead` receipted jobs also waiting */
export const sendBy = (deadline: number, ahead: number, o: ScheduleOpts) => deadline - o.marginSec - ahead * o.slotSec;

/** Whether a held job should be sent now: its random moment came, or it is running out of time */
export function isDue(j: { submitAt: number; deadline: number; receipt?: unknown }, nowMs: number, depth: number, o: ScheduleOpts) {
  if (j.submitAt <= nowMs) return true;
  return !!j.receipt && j.deadline > 0 && nowMs / 1000 >= sendBy(j.deadline, depth, o);
}

/** A revert means the call can't succeed now (final); anything else (network, rate limit, gas funds) is worth a retry */
export function failureKind(e: unknown): "revert" | "transient" {
  if (classify(e) === "transport") return "transient";
  return /revert/i.test(errorText(e)) ? "revert" : "transient";
}

/** Backoff before retry number `attempt` (1-based): 5 s, 10 s, 20 s, 40 s, then every 60 s */
export const retryDelayMs = (attempt: number) => Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(attempt - 1, 4)));

/** Tries for a job without a receipt; a receipted job is retried for as long as it can still be delivered */
export const MAX_ATTEMPTS = 8;
