// Local-only faucet for the dev wallet: gas plus 1,000 ZC. Disabled unless DEV_FAUCET_KEY is set.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const dynamic = "force-dynamic";

const erc20 = [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;

export async function POST(req: Request) {
  const key = process.env.DEV_FAUCET_KEY as Hex | undefined;
  const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8546";
  if (!key || !process.env.DEPLOYMENT) return Response.json({ error: "The faucet only runs on local deployments." }, { status: 404 });
  const { address } = (await req.json()) as { address?: string };
  if (!address || !isAddress(address)) return Response.json({ error: "Send a valid address." }, { status: 400 });

  const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, "utf8")) as { zc: `0x${string}` };
  const pub = createPublicClient({ transport: http(rpc) });
  const wallet = createWalletClient({ account: privateKeyToAccount(key), transport: http(rpc) });
  await pub.request({ method: "anvil_setBalance" as never, params: [address, "0xDE0B6B3A7640000"] as never });
  const hash = await wallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "transfer", args: [address, parseEther("1000")] });
  await pub.waitForTransactionReceipt({ hash });
  return Response.json({ ok: true, eth: "1", zc: "1000" });
}
