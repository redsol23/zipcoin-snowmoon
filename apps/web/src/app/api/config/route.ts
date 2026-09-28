// Runtime config for the wallet: contract addresses and which RPC/courier the browser should talk to.
import fs from "node:fs";

export const dynamic = "force-dynamic";

export function GET() {
  const path = process.env.DEPLOYMENT;
  if (!path || !fs.existsSync(path)) {
    return Response.json({ error: "Set DEPLOYMENT to a deployments/*.json file (run ./scripts/local-up.sh for a local one)." }, { status: 503 });
  }
  return Response.json({
    deployment: JSON.parse(fs.readFileSync(path, "utf8")),
    rpcUrl: process.env.PUBLIC_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8546",
    courierUrl: process.env.PUBLIC_COURIER_URL ?? process.env.COURIER_URL ?? "http://127.0.0.1:8720",
    devWallet: Boolean(process.env.DEV_FAUCET_KEY),
  });
}
