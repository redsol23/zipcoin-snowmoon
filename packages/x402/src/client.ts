import { toHex, type Address, type Hex } from "viem";

import { encodePaymentHeader, orderIdOf, SCHEME, X402_VERSION, type PaymentRequired, type Requirement } from "./protocol";

/**
 * Something that can pay a zipnet merchant privately: given the merchant, a base amount and an orderId, get a
 * ZipPay payment onto the chain (from a zipped note, through a courier). The Node payer in `payer.ts` does this with a
 * zip key; a browser wallet can do it with its own spend path.
 */
export type Payer = {
  pay(merchantId: bigint, base: bigint, orderId: Hex): Promise<void>;
};

export type PayingFetchOptions = {
  /** Calls to buy per payment (default: the server's suggestion) */
  calls?: number;
  /** Refuse to pay more than this base amount in one payment (ZC wei) */
  maxBase: bigint;
  /** How long to keep retrying after paying while the payment lands on-chain */
  settleTimeoutMs?: number;
};

/**
 * fetch that handles private x402: on 402 it pays with the zipnet scheme, then retries with X-PAYMENT, reusing the
 * same order's credits for later calls to the same merchant until they run out.
 */
export function payingFetch(payer: Payer, opts: PayingFetchOptions) {
  const credits = new Map<string, Hex>(); // merchantId -> orderSecret with calls left

  const withPayment = (init: RequestInit | undefined, secret: Hex, network: string): RequestInit => ({
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      "x-payment": encodePaymentHeader({ x402Version: X402_VERSION, scheme: SCHEME, network, payload: { orderSecret: secret } }),
    },
  });

  return async function fetchPaid(url: string, init?: RequestInit): Promise<Response> {
    let res = await fetch(url, init);
    if (res.status !== 402) return res;
    const req = (await res.json()) as PaymentRequired;
    const r: Requirement | undefined = req.accepts.find((a) => a.scheme === SCHEME);
    if (!r) throw new Error(`No zipnet payment option offered by ${url}`);

    // Reuse credits we already bought from this merchant
    const known = credits.get(r.extra.merchantId);
    if (known) {
      res = await fetch(url, withPayment(init, known, r.network));
      if (res.status !== 402) return res;
      credits.delete(r.extra.merchantId);
    }

    const calls = BigInt(opts.calls ?? r.extra.suggestedCalls);
    const base = BigInt(r.extra.pricePerCall) * calls;
    if (base > opts.maxBase) throw new Error(`Refusing to pay ${base} (over the limit of ${opts.maxBase})`);
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await payer.pay(BigInt(r.extra.merchantId), base, orderIdOf(secret));
    credits.set(r.extra.merchantId, secret);

    const deadline = Date.now() + (opts.settleTimeoutMs ?? 120_000);
    for (;;) {
      res = await fetch(url, withPayment(init, secret, r.network));
      if (res.status !== 402 || Date.now() > deadline) return res;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  };
}

export type { Address };
