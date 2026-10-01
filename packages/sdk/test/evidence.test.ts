import { encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { jobHashOf, keyAccepted, recoverInvoiceSigner, recoverReceiptSigner, ROUTE, signInvoice, signReceipt, type Invoice } from "../src/index";

const MERCHANTS = "0x00000000000000000000000000000000000000aa" as const;
const key = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

describe("evidence", () => {
  const inv: Invoice = { merchantId: 7n, amount: 50n * 10n ** 18n, orderId: `0x${"11".repeat(32)}`, route: ROUTE.UNTAXED, expiry: 2_000_000_000n };

  it("signs invoices with the merchant's signing key", async () => {
    const sig = await signInvoice(key, MERCHANTS, 1, inv);
    expect(await recoverInvoiceSigner(MERCHANTS, 1, inv, sig)).toBe(key.address);
    // bound to the chain and the contract
    expect(await recoverInvoiceSigner(MERCHANTS, 11155111, inv, sig)).not.toBe(key.address);
  });

  it("binds a receipt to the exact call, and signs it with the courier's key", async () => {
    const COURIERS = "0x00000000000000000000000000000000000000cc" as const;
    const target = "0x00000000000000000000000000000000000000ee" as const;
    const callData = "0xdeadbeef" as const;
    const jobHash = jobHashOf(target, callData);
    expect(jobHash).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [target, keccak256(callData)])));
    expect(jobHashOf(target, "0xdeadbeee")).not.toBe(jobHash);
    const message = { courier: other.address, nullifierHash: 5n, jobHash, deadline: 123n };
    const signature = await signReceipt(key, COURIERS, 1, message);
    expect(await recoverReceiptSigner(COURIERS, 1, message, signature)).toBe(key.address);
  });

  it("accepts the key in force, a pending key, and the previous key only until prevUntil", () => {
    const keys = { key: key.address, pending: null, prev: other.address, prevUntil: 1000 };
    expect(keyAccepted(keys, key.address, 5000)).toBe(true);
    expect(keyAccepted(keys, other.address, 1000)).toBe(true);
    expect(keyAccepted(keys, other.address, 1001)).toBe(false);
    expect(keyAccepted({ ...keys, prev: null, pending: other.address }, other.address, 5000)).toBe(true);
  });
});
