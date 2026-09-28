// The Veridia residents' public directory, for the wallet (Emerald uses it to recognize who an address belongs to).
import { services } from "@/lib/veridia";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${services.veridia}/cast`, { cache: "no-store" });
    return Response.json(await res.json());
  } catch {
    return Response.json([]);
  }
}
