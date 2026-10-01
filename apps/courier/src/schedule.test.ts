import assert from "node:assert/strict";
import { test } from "node:test";

import { failureKind, isDue, retryDelayMs, sendBy } from "./schedule";

const o = { marginSec: 300, slotSec: 3 };

test("M-1: a receipted job is sent a margin before its deadline, earlier with a queue ahead of it", () => {
  assert.equal(sendBy(10_000, 0, o), 9_700);
  assert.equal(sendBy(10_000, 20, o), 9_640);
});

test("M-1: a receipted job running short of time is due before its random moment; others wait for theirs", () => {
  const job = { submitAt: 9_900_000, deadline: 10_000, receipt: {} };
  assert.equal(isDue(job, 9_000_000, 0, o), false);
  assert.equal(isDue(job, 9_700_000, 0, o), true, "at deadline - margin");
  assert.equal(isDue(job, 9_640_000, 20, o), true, "earlier when 20 receipted jobs are waiting");
  assert.equal(isDue({ ...job, receipt: undefined }, 9_700_000, 0, o), false, "no receipt: sent at its moment");
  assert.equal(isDue(job, 9_900_000, 0, o), true);
});

test("M-2: only a revert is final; network errors, rate limits and unknown errors are retried", () => {
  const wrap = (name: string, message: string, cause?: unknown) => Object.assign(new Error(message), { name, cause });
  assert.equal(failureKind(wrap("ContractFunctionExecutionError", 'The contract function "relay" reverted.', wrap("ContractFunctionRevertedError", "reverted"))), "revert");
  assert.equal(failureKind(wrap("EstimateGasExecutionError", "Execution reverted with reason: NullifierAlreadySpent")), "revert");
  assert.equal(failureKind(wrap("HttpRequestError", "HTTP request failed. Status: 429")), "transient");
  assert.equal(failureKind(wrap("TimeoutError", "The request took too long to respond.")), "transient");
  assert.equal(failureKind(wrap("Error", "fetch failed", wrap("Error", "ECONNRESET"))), "transient");
  assert.equal(failureKind(wrap("InsufficientFundsError", "insufficient funds for gas * price + value")), "transient");
});

test("M-2: backoff grows to a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelayMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});
