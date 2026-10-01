import { Identity } from "@semaphore-protocol/core";
import { describe, expect, it } from "vitest";

import { isRootExpiredError, pickSignalSlot, semaphoreNullifier, signalScope, signalSlotNullifiers } from "../src/index";

const S = "0x00000000000000000000000000000000000000aa" as const;

describe("ZipSignal slots picked locally (A-3)", () => {
  const me = new Identity("board poster");
  const other = new Identity("someone else");

  it("computes each slot's nullifier from the local scope mirror", () => {
    const n = signalSlotNullifiers(me, S, 1, 7n, 20_000n);
    expect(n).toHaveLength(5);
    expect(n[3]).toBe(semaphoreNullifier(me, signalScope(S, 1, 7n, 20_000n, 3n)));
  });

  it("skips slots whose nullifier is already posted or pending here, and ignores others' posts", () => {
    const mine = signalSlotNullifiers(me, S, 1, 7n, 20_000n);
    const theirs = signalSlotNullifiers(other, S, 1, 7n, 20_000n);
    for (let i = 0; i < 20; i++) {
      const s = pickSignalSlot(me, S, 1, 7n, 20_000n, [mine[0], mine[1], ...theirs], [4]);
      expect([2n, 3n]).toContain(s);
    }
    expect(pickSignalSlot(me, S, 1, 7n, 20_000n, mine)).toBeNull();
    expect(pickSignalSlot(me, S, 1, 7n, 20_000n, mine.slice(0, 4))).toBe(4n);
  });

  it("recognises Semaphore's root-expired revert, decoded or as a bare selector (A-5)", () => {
    expect(isRootExpiredError(new Error("simulation reverted: reverted with the following signature: 0x9581a990"))).toBe(true);
    expect(isRootExpiredError("Semaphore__MerkleTreeRootIsExpired()")).toBe(true);
    expect(isRootExpiredError(new Error("simulation reverted: NullifierUsed()"))).toBe(false);
  });
});
