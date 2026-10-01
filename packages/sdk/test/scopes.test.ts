import { encodeAbiParameters, hexToBigInt, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { badgePayoutScope, checkBadgePayoutScope, contractScope, pollScope, signalScope } from "../src/index";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;

describe("Semaphore scopes", () => {
  it("is keccak256(abi.encode(tag, contract, chainId, ...ids)), like the contracts", () => {
    const manual = hexToBigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
          ["zipnet.post", A, 1n, 7n, 20_000n, 3n],
        ),
      ),
    );
    expect(signalScope(A, 1, 7n, 20_000n, 3n)).toBe(manual);
    expect(pollScope(A, 1, 5n)).toBe(contractScope("zipnet.poll", A, 1, 5n));
  });

  it("binds every scope to the contract and chain", () => {
    for (const f of [(a: typeof A, c: number) => pollScope(a, c, 1n), (a: typeof A, c: number) => signalScope(a, c, 1n, 100n, 0n), (a: typeof A, c: number) => badgePayoutScope(a, c, 1n, 0n)]) {
      expect(f(A, 1)).not.toBe(f(B as typeof A, 1));
      expect(f(A, 1)).not.toBe(f(A, 2));
    }
  });

  it("mirrors the badge-payout scope locally (A-9)", () => {
    expect(badgePayoutScope(A, 1, 4n, 2n)).toBe(contractScope("zipnet.badge.payout", A, 1, 4n, 2n));
    const s = badgePayoutScope(A, 1, 4n, 2n);
    expect(checkBadgePayoutScope(s, A, 1, 4n)).toBe(s);
    expect(() => checkBadgePayoutScope(pollScope(A, 1, 4n), A, 1, 4n)).toThrow();
  });

  it("gives a signal post a different scope (so nullifier) in each group", () => {
    expect(signalScope(A, 1, 1n, 100n, 0n)).not.toBe(signalScope(A, 1, 2n, 100n, 0n));
  });
});
