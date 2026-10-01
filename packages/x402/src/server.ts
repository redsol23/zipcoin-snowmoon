import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

import { zipPayAbi, type Deployment } from "@zipnet/sdk";

import { decodePaymentHeader, orderIdOf, SCHEME, X402_VERSION, type PaymentRequired } from "./protocol";

export type CreditOptions = {
  pub: PublicClient;
  deployment: Deployment;
  merchantId: bigint;
  /** Base price per call in ZC wei (sales tax is added on top at payment) */
  pricePerCall: bigint;
  /** How many calls a payment should buy, as a suggestion to clients */
  suggestedCalls?: number;
  description: string;
  /** Where the credit ledger persists (orderId → calls left); in memory only when unset */
  ledgerFile?: string;
  /** Further merchants paid in the same purchase, under the same orderId; calls = the fewest any part covers */
  split?: { merchantId: bigint; pricePerCall: bigint }[];
};

export type PaywallOptions = CreditOptions & { ledgerFile: string };

export type Spent = { ok: true; orderId: Hex; callsLeft: number } | { ok: false; error: string };

const paid = parseAbiItem(
  "event Paid(uint256 indexed merchantId, bytes32 indexed orderId, address indexed payer, uint256 nullifierHash, uint256 base, uint256 tax, uint256 fee, uint256 identityCommitment, bytes receipt)",
);

/**
 * The transport-free core of a private x402 paywall: what a 402 offers, and a ledger that turns an on-chain ZipPay
 * payment into prepaid calls. `paywall` wraps it for node:http; other servers (e.g. a Next route) use it directly.
 */
export function creditLedger(o: CreditOptions) {
  const ledger: Record<string, number> = o.ledgerFile && fs.existsSync(o.ledgerFile) ? JSON.parse(fs.readFileSync(o.ledgerFile, "utf8")) : {};
  const save = () => o.ledgerFile && fs.writeFileSync(o.ledgerFile, JSON.stringify(ledger));
  let taxBps: bigint | null = null;
  const parts = [{ merchantId: o.merchantId, pricePerCall: o.pricePerCall }, ...(o.split ?? [])];
  const perCall = parts.reduce((a, p) => a + p.pricePerCall, 0n);

  const required = async (resource: string, error: string): Promise<PaymentRequired> => {
    taxBps ??= (await o.pub.readContract({ address: o.deployment.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
    const calls = o.suggestedCalls ?? 10;
    return {
      x402Version: X402_VERSION,
      error,
      accepts: [
        {
          scheme: SCHEME,
          network: `eip155:${o.deployment.chainId}`,
          maxAmountRequired: (perCall * BigInt(calls)).toString(),
          resource,
          description: o.description,
          mimeType: "application/json",
          payTo: o.deployment.pay as Address,
          asset: o.deployment.zc as Address,
          maxTimeoutSeconds: 600,
          extra: {
            merchantId: o.merchantId.toString(),
            pricePerCall: o.pricePerCall.toString(),
            suggestedCalls: calls,
            taxBps: taxBps.toString(),
            ...(o.split?.length ? { split: o.split.map((s) => ({ merchantId: s.merchantId.toString(), pricePerCall: s.pricePerCall.toString() })) } : {}),
          },
        },
      ],
    };
  };

  /** Spends one call of the order behind an X-PAYMENT header. */
  const spend = async (header: string | null | undefined): Promise<Spent> => {
    if (typeof header !== "string") return { ok: false, error: "Payment required. Pay privately with zipcoin, then send X-PAYMENT." };
    const p = decodePaymentHeader(header);
    if (!p) return { ok: false, error: "X-PAYMENT isn't a zipnet payment." };
    const orderId = orderIdOf(p.payload.orderSecret);
    if (ledger[orderId] === undefined) {
      // First use of this order: find its payment (every part of it) on-chain and turn it into credits
      const calls = await Promise.all(
        parts.map(async (part) => {
          const logs = await o.pub.getLogs({ address: o.deployment.pay, event: paid, args: { merchantId: part.merchantId, orderId }, fromBlock: BigInt(o.deployment.deployBlock) });
          return logs.reduce((a, l) => a + l.args.base!, 0n) / part.pricePerCall;
        }),
      );
      if (calls.some((c) => c === 0n)) return { ok: false, error: "No payment found for this order yet. If you just paid, retry in a few seconds." };
      ledger[orderId] = Number(calls.reduce((a, c) => (c < a ? c : a)));
    }
    if (ledger[orderId] <= 0) return { ok: false, error: "This payment's calls are used up. Pay again for more." };
    ledger[orderId] -= 1;
    save();
    return { ok: true, orderId, callsLeft: ledger[orderId] };
  };

  /** Gives back a call that was spent but not served (e.g. the upstream failed). */
  const refund = (orderId: Hex) => {
    if (ledger[orderId] === undefined) return;
    ledger[orderId] += 1;
    save();
  };

  return { required, spend, refund };
}

/**
 * Guards an HTTP handler with a private x402 paywall. Returns `true` when the request may proceed (and one credit was
 * spent), or writes a 402 and returns `false`.
 */
export function paywall(o: PaywallOptions) {
  const credits = creditLedger(o);

  return async function charge(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const header = req.headers["x-payment"];
    const r = await credits.spend(typeof header === "string" ? header : null);
    if (!r.ok) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(await credits.required(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, r.error)));
      return false;
    }
    res.setHeader("x-payment-response", Buffer.from(JSON.stringify({ scheme: SCHEME, callsLeft: r.callsLeft })).toString("base64"));
    return true;
  };
}
