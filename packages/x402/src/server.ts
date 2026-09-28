import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAbiItem, type Address, type PublicClient } from "viem";

import { zipPayAbi, type Deployment } from "@zipnet/sdk";

import { decodePaymentHeader, orderIdOf, SCHEME, X402_VERSION, type PaymentRequired } from "./protocol";

export type PaywallOptions = {
  pub: PublicClient;
  deployment: Deployment;
  merchantId: bigint;
  /** Base price per call in ZC wei (sales tax is added on top at payment) */
  pricePerCall: bigint;
  /** How many calls a payment should buy, as a suggestion to clients */
  suggestedCalls?: number;
  description: string;
  /** Where the credit ledger persists (orderId → calls left) */
  ledgerFile: string;
};

const paid = parseAbiItem(
  "event Paid(uint256 indexed merchantId, bytes32 indexed orderId, address indexed payer, uint256 nullifierHash, uint256 base, uint256 tax, uint256 fee, uint256 identityCommitment, bytes receipt)",
);

/**
 * Guards an HTTP handler with a private x402 paywall. Returns `true` when the request may proceed (and one credit was
 * spent), or writes a 402 and returns `false`.
 */
export function paywall(o: PaywallOptions) {
  const ledger: Record<string, number> = fs.existsSync(o.ledgerFile) ? JSON.parse(fs.readFileSync(o.ledgerFile, "utf8")) : {};
  const save = () => fs.writeFileSync(o.ledgerFile, JSON.stringify(ledger));
  let taxBps: bigint | null = null;

  const required = async (req: IncomingMessage, error: string): Promise<PaymentRequired> => {
    taxBps ??= (await o.pub.readContract({ address: o.deployment.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
    const calls = o.suggestedCalls ?? 10;
    return {
      x402Version: X402_VERSION,
      error,
      accepts: [
        {
          scheme: SCHEME,
          network: `eip155:${o.deployment.chainId}`,
          maxAmountRequired: (o.pricePerCall * BigInt(calls)).toString(),
          resource: `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
          description: o.description,
          mimeType: "application/json",
          payTo: o.deployment.pay as Address,
          asset: o.deployment.zc as Address,
          maxTimeoutSeconds: 600,
          extra: { merchantId: o.merchantId.toString(), pricePerCall: o.pricePerCall.toString(), suggestedCalls: calls, taxBps: taxBps.toString() },
        },
      ],
    };
  };

  const refuse = async (req: IncomingMessage, res: ServerResponse, error: string) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(await required(req, error)));
    return false;
  };

  return async function charge(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const header = req.headers["x-payment"];
    if (typeof header !== "string") return refuse(req, res, "Payment required. Pay privately with zipcoin, then send X-PAYMENT.");
    const p = decodePaymentHeader(header);
    if (!p) return refuse(req, res, "X-PAYMENT isn't a zipnet payment.");
    const orderId = orderIdOf(p.payload.orderSecret);

    if (ledger[orderId] === undefined) {
      // First use of this order: find its payment on-chain and turn it into credits
      const logs = await o.pub.getLogs({
        address: o.deployment.pay,
        event: paid,
        args: { merchantId: o.merchantId, orderId },
        fromBlock: BigInt(o.deployment.deployBlock),
      });
      if (logs.length === 0) return refuse(req, res, "No payment found for this order yet. If you just paid, retry in a few seconds.");
      const base = logs.reduce((a, l) => a + l.args.base!, 0n);
      ledger[orderId] = Number(base / o.pricePerCall);
    }
    if (ledger[orderId] <= 0) return refuse(req, res, "This payment's calls are used up. Pay again for more.");
    ledger[orderId] -= 1;
    save();
    res.setHeader("x-payment-response", Buffer.from(JSON.stringify({ scheme: SCHEME, callsLeft: ledger[orderId] })).toString("base64"));
    return true;
  };
}
