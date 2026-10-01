import { insertGasHeadroom, masterKeys, mnemonicFromSignature } from "@zipnet/sdk";
import { describe, expect, it } from "vitest";

import { zip } from "../src/lib/wallet";

const deployment = {
  zc: "0x00000000000000000000000000000000000000c0",
  entrypoint: "0x00000000000000000000000000000000000000e0",
  pool: "0x00000000000000000000000000000000000000f0",
  scope: 7n,
};
const keys = masterKeys(mnemonicFromSignature(`0x${"11".repeat(65)}`));

/** A chain where the deposit estimates at 330k with a tree 9 levels deep, and each transaction ends as `status` says */
function chain(status: { approve: "success" | "reverted"; deposit: "success" | "reverted" }) {
  const sent: { functionName: string; gas?: bigint }[] = [];
  const wallet = {
    account: { address: "0x00000000000000000000000000000000000000aa", type: "json-rpc" },
    writeContract: async (a: { functionName: string; gas?: bigint }) => {
      sent.push({ functionName: a.functionName, gas: a.gas });
      return a.functionName === "approve" ? "0x01" : "0x02";
    },
  };
  const pub = {
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: hash === "0x01" ? status.approve : status.deposit }),
    estimateContractGas: async () => 330_000n,
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "currentTreeDepth" ? 9n : 0n),
  };
  return { sent, wallet, pub };
}

describe("zip", () => {
  it("gives the deposit headroom for its leaf insert: other deposits in the block make it dearer than estimated", async () => {
    const c = chain({ approve: "success", deposit: "success" });
    await zip({ deployment } as never, c.pub as never, c.wallet as never, keys, 0n, 10n ** 18n);
    const deposit = c.sent.find((s) => s.functionName === "deposit")!;
    expect(deposit.gas).toBe(330_000n + insertGasHeadroom(9n));
    expect(deposit.gas! - 330_000n).toBeGreaterThanOrEqual(9n * 30_000n);
  });

  it("a reverted deposit is an error, not 'zipped'", async () => {
    const c = chain({ approve: "success", deposit: "reverted" });
    await expect(zip({ deployment } as never, c.pub as never, c.wallet as never, keys, 0n, 1n)).rejects.toThrow(/nothing was zipped/);
  });

  it("a reverted approval stops before the deposit", async () => {
    const c = chain({ approve: "reverted", deposit: "success" });
    await expect(zip({ deployment } as never, c.pub as never, c.wallet as never, keys, 0n, 1n)).rejects.toThrow(/nothing was zipped/);
    expect(c.sent.map((s) => s.functionName)).toEqual(["approve"]);
  });
});
