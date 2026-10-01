// Runtime config for the wallet: contract addresses and which RPC/courier the browser should talk to.
// Only PUBLIC_RPC_URL is ever sent (lib/public-config.ts); without it this answers 503 with a configuration error.
import { publicConfig } from "@/lib/public-config";

export const dynamic = "force-dynamic";

export function GET() {
  const { status, body } = publicConfig(process.env);
  return Response.json(body, { status });
}
