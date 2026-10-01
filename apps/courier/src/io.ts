import { encodeFunctionData, type Abi, type Account, type Address, type Chain, type PublicClient, type TransactionReceipt, type Transport, type WalletClient } from "viem";

import type { Fees, SenderIo, TxArgs } from "./sender";

/**
 * The send queue's chain access. Everything is read, estimated and signed against the read node (`pub`, `wallet`);
 * only the signed transaction goes to the send endpoint (`sendPub`, SEND_RPC_URL), which may be a private relay that
 * answers nothing else.
 */
export function chainIo(o: {
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain | undefined, Account>;
  sendPub: PublicClient;
  chainId: number;
}): SenderIo<TransactionReceipt> {
  const { pub, wallet, sendPub, chainId } = o;
  const address: Address = wallet.account.address;
  const signPrepared = async (tx: Record<string, unknown>) => {
    // Estimates gas on the read node when `gas` isn't given: a call that would revert throws here
    const req = await wallet.prepareTransactionRequest({ chain: null, chainId, type: "eip1559", ...tx } as never);
    return wallet.signTransaction(req as never);
  };
  return {
    latestNonce: () => pub.getTransactionCount({ address, blockTag: "latest" }),
    fees: async () => {
      const f = await pub.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas ?? 1_000_000_000n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 1_000_000n };
    },
    async sign(args: TxArgs, nonce: number, fees: Fees) {
      // gasExtra: added to the estimate (a pool insert's headroom)
      const a = args as { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; gasExtra?: bigint };
      const data = encodeFunctionData({ abi: a.abi, functionName: a.functionName, args: a.args ?? [] } as never);
      if (!a.gasExtra) return signPrepared({ to: a.address, data, value: a.value, nonce, ...fees });
      // Still estimated (the estimate is the simulation: it throws if the call would revert)
      const gas = (await pub.estimateGas({ account: wallet.account, to: a.address, data, value: a.value })) + a.gasExtra;
      return signPrepared({ to: a.address, data, value: a.value, nonce, ...fees, gas });
    },
    signCancel: (nonce: number, fees: Fees) => signPrepared({ to: address, value: 0n, gas: 21_000n, nonce, ...fees }),
    sendRaw: (raw) => sendPub.sendRawTransaction({ serializedTransaction: raw }),
    receipt: (hash) => pub.getTransactionReceipt({ hash }).catch(() => null),
  };
}
