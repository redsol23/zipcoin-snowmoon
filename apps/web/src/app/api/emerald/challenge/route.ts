// The message a wallet signs to sign in to Emerald (the linking option). Stateless: its nonce is an HMAC token.
import { challengeFor } from "@/lib/emerald/gate";
import { gateDeps, GateUnavailable } from "@/lib/emerald/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  try {
    const c = challengeFor(await gateDeps(), address);
    if (!c) return Response.json({ error: "Pass ?address= with a valid Ethereum address." }, { status: 400 });
    return Response.json(c);
  } catch (e) {
    if (e instanceof GateUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
