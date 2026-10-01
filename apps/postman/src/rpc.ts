import { http, type Transport } from "viem";

/** JSON-RPC methods that broadcast; everything else (nonces, estimates, reads, receipts) stays on the read node */
const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendPrivateTransaction", "eth_cancelPrivateTransaction"]);

/**
 * A transport that reads from `readUrl` and broadcasts through `sendUrl` (SEND_RPC_URL): a wallet client built on it
 * prepares and signs against the read node and hands only the signed transaction to the send endpoint, which may be a
 * private relay that answers nothing else. Without `sendUrl` it is plain http(readUrl).
 */
export function splitTransport(readUrl: string, sendUrl?: string): Transport {
  const read = http(readUrl);
  if (!sendUrl || sendUrl === readUrl) return read;
  const send = http(sendUrl);
  return ((opts: Parameters<Transport>[0]) => {
    const r = read(opts);
    const s = send(opts);
    const request = ((args: { method: string }) => (SEND_METHODS.has(args.method) ? s.request(args as never) : r.request(args as never))) as typeof r.request;
    return { ...r, request };
  }) as Transport;
}
