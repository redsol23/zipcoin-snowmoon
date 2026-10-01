// Emerald sign-in: a badge proof (anonymous) or a signed wallet challenge (links the wallet) buys a short session.
import { issueBadgeSession, issueWalletSession } from "@/lib/emerald/gate";
import { gateDeps, GateUnavailable } from "@/lib/emerald/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 20_000) return Response.json({ error: "That sign-in is too large." }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  try {
    const d = await gateDeps();
    const r = body.kind === "badge" ? await issueBadgeSession(d, body) : body.kind === "wallet" ? await issueWalletSession(d, body) : null;
    if (!r) return Response.json({ error: 'kind must be "badge" or "wallet".' }, { status: 400 });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ token: r.token, kind: r.kind, expiresAt: r.expiresAt });
  } catch (e) {
    if (e instanceof GateUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
