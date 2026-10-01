// The Veridia residents' public directory: names, cities, bios and shops. It lists no wallets or zip addresses.
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
