import assert from "node:assert/strict";
import { test } from "node:test";

import { BADGE_PAYOUT, badgePayoutMessage, SNARK_SCALAR_FIELD } from "@zipnet/sdk";

import { isPayoutKind, PAYOUT_GAS, PAYOUT_KINDS, PayoutArgError, payoutArgs, payoutTarget } from "./payouts";

const TO = "0x00000000000000000000000000000000000000bB";
const SIG = `0x${"ab".repeat(65)}`;
const PRE = 12345678901234567890n;

/** A Semaphore proof as it arrives in JSON (decimal strings), bound to `message` */
const semProof = (message: bigint, over: Record<string, unknown> = {}) => ({
  merkleTreeDepth: "1",
  merkleTreeRoot: "987654321",
  nullifier: "11",
  message: message.toString(),
  scope: "22",
  points: Array.from({ length: 8 }, (_, i) => String(i + 1)),
  ...over,
});

const rq = (over: Record<string, unknown> = {}) => ({ pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"], pubSignals: ["9", "10", "5000000000000000000", "12"], ...over });

const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PayoutArgError && re.test((e as Error).message));

test("three kinds: redirect, release and ragequit on ZipBadges", () => {
  assert.equal(PAYOUT_KINDS.length, 3);
  assert.deepEqual(payoutTarget("badgeRedirect"), { contract: "badges", fn: "redirectPayout" });
  assert.deepEqual(payoutTarget("badgeRelease"), { contract: "badges", fn: "releasePayout" });
  assert.deepEqual(payoutTarget("badgeRagequit"), { contract: "badges", fn: "ragequitPayout" });
  for (const k of PAYOUT_KINDS) {
    assert.ok(PAYOUT_GAS[k] > 0n, `${k} has a gas figure`);
    assert.ok(isPayoutKind(k));
  }
  assert.ok(!isPayoutKind("unlock"));
});

test("bad ids, targets and argument counts are refused before any simulation", () => {
  const m = semProof(badgePayoutMessage(BADGE_PAYOUT.release, TO));
  rejects(() => payoutArgs("badgeRelease", ["0", TO, m]), /at least 1/);
  rejects(() => payoutArgs("badgeRelease", [(2n ** 64n).toString(), TO, m]), /below/);
  rejects(() => payoutArgs("badgeRelease", ["-1", TO, m]), /whole number/);
  rejects(() => payoutArgs("badgeRelease", ["1.5", TO, m]), /whole number/);
  rejects(() => payoutArgs("badgeRelease", ["1", TO]), /3 entries/);
  rejects(() => payoutArgs("badgeRelease", undefined), /3 entries/);
  rejects(() => payoutArgs("badgeRagequit", ["1", rq(), TO]), /4 entries/);
  rejects(() => payoutArgs("badgeRelease", ["1", "0x0000000000000000000000000000000000000000", m]), /zero address/);
  rejects(() => payoutArgs("badgeRelease", ["1", "bob.eth", m]), /address/);
  rejects(() => payoutArgs("badgeRedirect", ["1", "0", m]), /zero/);
  rejects(() => payoutArgs("badgeRedirect", ["1", SNARK_SCALAR_FIELD.toString(), m]), /precommitment/);
});

test("ragequit proofs must have the ProofLib shape and a non-empty note", () => {
  const m = semProof(badgePayoutMessage(BADGE_PAYOUT.ragequit, TO));
  rejects(() => payoutArgs("badgeRagequit", ["1", rq({ pA: ["1"] }), TO, m]), /pA must have 2/);
  rejects(() => payoutArgs("badgeRagequit", ["1", rq({ pB: [["1", "2"]] }), TO, m]), /pB must have 2/);
  rejects(() => payoutArgs("badgeRagequit", ["1", rq({ pubSignals: ["1", "2", "0", "4"] }), TO, m]), /holds nothing/);
  rejects(() => payoutArgs("badgeRagequit", ["1", rq({ pubSignals: ["1", "2", "3", SNARK_SCALAR_FIELD.toString()] }), TO, m]), /pubSignals\[3\]/);
  rejects(() => payoutArgs("badgeRagequit", ["1", null, TO, m]), /missing/);
});

test("badge calls carry a SoloProof whose message binds this action and target", () => {
  const redirect = payoutArgs("badgeRedirect", ["4", PRE.toString(), semProof(badgePayoutMessage(BADGE_PAYOUT.redirect, PRE))]) as [bigint, bigint, { points: bigint[]; merkleTreeDepth: bigint }];
  assert.equal(redirect[0], 4n);
  assert.equal(redirect[1], PRE);
  assert.equal(redirect[2].points.length, 8);
  assert.equal(redirect[2].merkleTreeDepth, 1n);

  const release = payoutArgs("badgeRelease", ["4", TO, semProof(badgePayoutMessage(BADGE_PAYOUT.release, TO))]);
  assert.equal(release[1], TO);
  payoutArgs("badgeRagequit", ["4", rq(), TO, semProof(badgePayoutMessage(BADGE_PAYOUT.ragequit, TO))]);

  // A proof made for another recipient, another action or another precommitment is refused
  const other = "0x00000000000000000000000000000000000000cc";
  rejects(() => payoutArgs("badgeRelease", ["4", TO, semProof(badgePayoutMessage(BADGE_PAYOUT.release, other))]), /doesn't authorise/);
  rejects(() => payoutArgs("badgeRagequit", ["4", rq(), TO, semProof(badgePayoutMessage(BADGE_PAYOUT.release, TO))]), /doesn't authorise/);
  rejects(() => payoutArgs("badgeRedirect", ["4", PRE.toString(), semProof(badgePayoutMessage(BADGE_PAYOUT.redirect, PRE + 1n))]), /doesn't authorise/);
  // Malformed proofs
  const m = badgePayoutMessage(BADGE_PAYOUT.release, TO);
  rejects(() => payoutArgs("badgeRelease", ["4", TO, semProof(m, { merkleTreeDepth: "0" })]), /1 to 32/);
  rejects(() => payoutArgs("badgeRelease", ["4", TO, semProof(m, { merkleTreeDepth: "33" })]), /merkleTreeDepth/);
  rejects(() => payoutArgs("badgeRelease", ["4", TO, semProof(m, { points: ["1"] })]), /points must have 8/);
  rejects(() => payoutArgs("badgeRelease", ["4", TO, semProof(m, { merkleTreeRoot: "0" })]), /no identity/);
  rejects(() => payoutArgs("badgeRelease", ["4", TO, SIG]), /Semaphore proof/);
});
