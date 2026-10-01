import { encodeAbiParameters, keccak256, recoverTypedDataAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";

import { zipCouriersAbi, zipMerchantsAbi } from "./abi";

/**
 * Evidence the network slashes on: merchant invoices (ZipMerchants) and courier receipts (ZipCouriers).
 *
 * Both are EIP-712 messages checked on-chain with plain ECDSA only (never ERC-1271), so a signer that later becomes a
 * contract (an EIP-7702 delegation) can't void them. Each merchant and courier has a signing key: its own address by
 * default, or a separate EOA key registered with `registerWithKey` / `bondWithKey`, rotated with a delay
 * (`rotateSigningKey`). `signingKeys` reads which keys count right now; verify a signature against them, not against
 * the staker's address.
 */

export const ROUTE = { TAXED: 0, UNTAXED: 1 } as const;
export type Invoice = { merchantId: bigint; amount: bigint; orderId: Hex; route: number; expiry: bigint };

export const INVOICE_TYPES = {
  Invoice: [
    { name: "merchantId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "orderId", type: "bytes32" },
    { name: "route", type: "uint8" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const invoiceDomain = (merchants: Address, chainId: number) => ({ name: "zipnet merchants", version: "1", chainId, verifyingContract: merchants }) as const;

/** Signs an invoice with the merchant's signing key (an EOA: a local account, never a contract wallet) */
export function signInvoice(key: LocalAccount, merchants: Address, chainId: number, invoice: Invoice): Promise<Hex> {
  return key.signTypedData({ domain: invoiceDomain(merchants, chainId), types: INVOICE_TYPES, primaryType: "Invoice", message: invoice });
}

export const recoverInvoiceSigner = (merchants: Address, chainId: number, invoice: Invoice, signature: Hex) =>
  recoverTypedDataAddress({ domain: invoiceDomain(merchants, chainId), types: INVOICE_TYPES, primaryType: "Invoice", message: invoice, signature });

/** The keys whose signatures count now: the key in force, a pending one (also accepted), the previous one until `prevUntil` */
export type SigningKeys = { key: Address; pending: Address | null; prev: Address | null; prevUntil: number };

const ZERO = /^0x0{40}$/i;
const orNull = (a: Address) => (ZERO.test(a) ? null : a);

/** A merchant's (by id) or a courier's (by address) signing keys, as the contract will check them now */
export async function signingKeys(client: PublicClient, contract: Address, of: { merchantId: bigint } | { courier: Address }): Promise<SigningKeys> {
  const r = ("merchantId" in of
    ? await client.readContract({ address: contract, abi: zipMerchantsAbi, functionName: "signingKeysOf", args: [of.merchantId] })
    : await client.readContract({ address: contract, abi: zipCouriersAbi, functionName: "signingKeysOf", args: [of.courier] })) as readonly [Address, Address, Address, bigint];
  return { key: r[0], pending: orNull(r[1]), prev: orNull(r[2]), prevUntil: Number(r[3]) };
}

/** Whether `signer` counts for these keys at unix time `now` (the contract's rule) */
export function keyAccepted(keys: SigningKeys, signer: Address, now = Math.floor(Date.now() / 1000)) {
  const s = signer.toLowerCase();
  return s === keys.key.toLowerCase() || s === keys.pending?.toLowerCase() || (s === keys.prev?.toLowerCase() && now <= keys.prevUntil);
}

/**
 * Checks an invoice a merchant handed over: signed by one of its current signing keys. An inspector keeps an untaxed
 * invoice that passes this as evidence (ZipMerchants.commitReport, then report).
 */
export async function verifyInvoice(client: PublicClient, merchants: Address, chainId: number, invoice: Invoice, signature: Hex) {
  const signer = await recoverInvoiceSigner(merchants, chainId, invoice, signature);
  return keyAccepted(await signingKeys(client, merchants, { merchantId: invoice.merchantId }), signer);
}

// ---------------------------------------------------------------------------------------------------------------
// courier receipts
// ---------------------------------------------------------------------------------------------------------------

/**
 * A courier's promise to deliver one exact job by `deadline`. `jobHash = jobHashOf(target, callData)`: the contract the
 * courier calls and the calldata (the withdrawal and proof, so the processooor, data, amount, scope and nullifier are
 * all fixed). ZipCouriers.report(receipt, signature, salt, target, callData) makes the delivery itself after the
 * deadline and slashes only if it succeeds, so keep `target` and `callData` with the receipt.
 */
export type Receipt = { courier: Address; nullifierHash: bigint; jobHash: Hex; deadline: bigint };
/** What a courier hands back for a held job: the signed receipt plus the call it promises (needed to report) */
export type SignedReceipt = { message: Receipt; signature: Hex; target: Address; callData: Hex };

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "courier", type: "address" },
    { name: "nullifierHash", type: "uint256" },
    { name: "jobHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const receiptDomain = (couriers: Address, chainId: number) => ({ name: "zipnet couriers", version: "1", chainId, verifyingContract: couriers }) as const;

/** ZipCouriers.jobHashOf: keccak256(abi.encode(target, keccak256(callData))) */
export const jobHashOf = (target: Address, callData: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [target, keccak256(callData)]));

export function signReceipt(key: LocalAccount, couriers: Address, chainId: number, receipt: Receipt): Promise<Hex> {
  return key.signTypedData({ domain: receiptDomain(couriers, chainId), types: RECEIPT_TYPES, primaryType: "Receipt", message: receipt });
}

export const recoverReceiptSigner = (couriers: Address, chainId: number, receipt: Receipt, signature: Hex) =>
  recoverTypedDataAddress({ domain: receiptDomain(couriers, chainId), types: RECEIPT_TYPES, primaryType: "Receipt", message: receipt, signature });

/**
 * Checks a receipt a courier returned for a held job: the call it carries hashes to its `jobHash`, it is signed by one
 * of the named courier's current signing keys, its deadline is no more than `maxAheadSec` away (an ASP epoch; review
 * 2 I-5), and an unbonding courier's stake is still there after the deadline. A receipt that fails this can't be
 * enforced, so don't let a courier hold the job on it.
 */
export async function verifyReceipt(client: PublicClient, couriers: Address, chainId: number, r: SignedReceipt, opts: { maxAheadSec?: number; now?: number } = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Number(r.message.deadline) > now + (opts.maxAheadSec ?? 86_400)) return false;
  if (jobHashOf(r.target, r.callData).toLowerCase() !== r.message.jobHash.toLowerCase()) return false;
  const [, unbondAt] = (await client.readContract({ address: couriers, abi: zipCouriersAbi, functionName: "couriers", args: [r.message.courier] })) as readonly [bigint, bigint, string];
  if (unbondAt !== 0n && r.message.deadline >= unbondAt) return false;
  const signer = await recoverReceiptSigner(couriers, chainId, r.message, r.signature);
  return keyAccepted(await signingKeys(client, couriers, { courier: r.message.courier }), signer);
}
