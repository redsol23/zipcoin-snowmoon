import { keccak256, type Address, type Hex } from "viem";

/**
 * x402 with a private payment scheme.
 *
 * x402 turns HTTP 402 into a payment step: the server answers 402 with what it accepts, the client pays and retries
 * with an `X-PAYMENT` header. The usual schemes pay from a visible wallet. The `zipnet` scheme pays from a zipped
 * note through ZipPay: the API provider (a listed merchant) learns that it was paid, and sales tax is settled in the
 * same proof, but nobody learns who paid.
 *
 * Binding a payment to a caller without revealing the caller: the client picks a random 32-byte `orderSecret` and
 * pays with `orderId = keccak256(orderSecret)`. To spend the credit it presents the secret; the server checks the
 * Paid event for that orderId. Only the payer knows the secret, so only the payer can use the credit, and the chain
 * never links the secret to a wallet. One payment buys `floor(base / pricePerCall)` calls (metered, prepaid).
 */

export const X402_VERSION = 1;
export const SCHEME = "zipnet";

export type Requirement = {
  scheme: typeof SCHEME;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: {
    merchantId: string;
    pricePerCall: string;
    suggestedCalls: number;
    taxBps: string;
    /**
     * More ZipPay payments that belong to the same purchase, each to its own merchant and with the same orderId (e.g.
     * a share whose payout is the burn address). The purchase buys calls only once every part has landed.
     */
    split?: { merchantId: string; pricePerCall: string }[];
  };
};

export type PaymentRequired = { x402Version: number; error: string; accepts: Requirement[] };

export type PaymentPayload = { x402Version: number; scheme: typeof SCHEME; network: string; payload: { orderSecret: Hex } };

export const orderIdOf = (orderSecret: Hex) => keccak256(orderSecret);

// Base64 that works in Node and in browsers (the header is ASCII JSON, so btoa/atob are enough there)
const toB64 = (s: string) => (typeof Buffer !== "undefined" ? Buffer.from(s).toString("base64") : btoa(s));
const fromB64 = (s: string) => (typeof Buffer !== "undefined" ? Buffer.from(s, "base64").toString("utf8") : atob(s));

export const encodePaymentHeader = (p: PaymentPayload) => toB64(JSON.stringify(p));

export function decodePaymentHeader(header: string): PaymentPayload | null {
  try {
    const p = JSON.parse(fromB64(header)) as PaymentPayload;
    if (p.scheme !== SCHEME || !/^0x[0-9a-fA-F]{64}$/.test(p.payload?.orderSecret ?? "")) return null;
    return p;
  } catch {
    return null;
  }
}
