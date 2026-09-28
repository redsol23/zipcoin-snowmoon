import { parseAbiItem, type Hex, type PublicClient } from "viem";

import {
  context,
  encodePayment,
  parsePoolState,
  proveLeaf,
  proveSpend,
  recoverNotes,
  toJson,
  withdrawalSecrets,
  zipPayAbi,
  type Deployment,
  type MasterKeys,
  type PoolState,
} from "@zipnet/sdk";

import type { Payer } from "./client";

const paid = parseAbiItem(
  "event Paid(uint256 indexed merchantId, bytes32 indexed orderId, address indexed payer, uint256 nullifierHash, uint256 base, uint256 tax, uint256 fee, uint256 identityCommitment, bytes receipt)",
);

/**
 * Pays from a zip key's notes through a courier. For AI agents and services: the paying agent never exposes a wallet,
 * only a spent note, and sales tax is settled in the same proof.
 */
export function notePayer(o: { pub: PublicClient; deployment: Deployment; keys: MasterKeys; zipAddressKey?: Uint8Array; courierUrl: string }): Payer {
  return {
    async pay(merchantId: bigint, base: bigint, orderId: Hex) {
      const dep = o.deployment;
      const [stateText, asp, quote, taxBps] = await Promise.all([
        fetch(`${o.courierUrl}/state`).then((r) => r.text()),
        fetch(`${o.courierUrl}/asp`).then((r) => r.json() as Promise<{ labels: string[] }>),
        fetch(`${o.courierUrl}/quote`).then((r) => r.json() as Promise<{ courier: `0x${string}`; fees: Record<string, string> }>),
        o.pub.readContract({ address: dep.pay, abi: zipPayAbi, functionName: "TAX_BPS" }) as Promise<bigint>,
      ]);
      const state = parsePoolState<PoolState>(stateText);
      const labels = asp.labels.map(BigInt);
      const fee = BigInt(quote.fees.pay ?? "0");
      const total = base + (base * taxBps) / 10_000n + fee;

      const { notes } = recoverNotes(o.keys, dep.scope, state, { zipAddressKey: o.zipAddressKey });
      const note = notes.filter((n) => labels.includes(n.label) && n.value >= total).sort((a, b) => (a.value < b.value ? -1 : 1))[0];
      if (!note) throw new Error(`No cleared note holds ${total} (base + tax + courier fee). Zip more first.`);

      const data = encodePayment({
        merchantId,
        base,
        orderId,
        payeePrecommitment: 0n,
        identityCommitment: 0n,
        receipt: "0x",
        courier: { feeRecipient: quote.courier, fee },
      });
      const next = withdrawalSecrets(o.keys, note.label, note.children);
      const proof = await proveSpend({
        value: note.value,
        label: note.label,
        nullifier: note.nullifier,
        secret: note.secret,
        newNullifier: next.nullifier,
        newSecret: next.secret,
        amount: total,
        context: context({ processooor: dep.pay, data }, dep.scope),
        state: proveLeaf(state.leaves, note.commitment),
        asp: proveLeaf(labels, note.label),
      });
      const res = await fetch(`${o.courierUrl}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({ kind: "pay", holdSec: 0, withdrawal: { processooor: dep.pay, data }, proof }),
      });
      if (!res.ok) throw new Error(`Courier refused the payment: ${((await res.json()) as { error: string }).error}`);

      // Wait until the payment is on-chain so the API can see it
      for (let i = 0; i < 60; i++) {
        const logs = await o.pub.getLogs({ address: dep.pay, event: paid, args: { merchantId, orderId }, fromBlock: BigInt(dep.deployBlock) });
        if (logs.length) return;
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      throw new Error("The payment didn't land within two minutes.");
    },
  };
}
