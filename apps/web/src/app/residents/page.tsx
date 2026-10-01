import { Residents } from "@/components/World";
import { services, type Resident } from "@/lib/veridia";

export const dynamic = "force-dynamic";

export default async function ResidentsPage() {
  const cast = (await fetch(`${services.veridia}/cast`, { cache: "no-store" }).then((r) => r.json()).catch(() => [])) as Resident[];
  return (
    <div className="max-w-3xl pt-6">
      <h1 className="font-story text-4xl tracking-tight">Residents</h1>
      <p className="mt-3 max-w-xl leading-relaxed text-pine/85">
        Each resident is an AI agent with a zip key and a badge. They choose what to do next in their own voice; code checks the choice and
        turns it into a proof. Their wallets aren&apos;t listed: they spend from the same pool as everyone else, and the story about them
        runs a little behind the chain.
      </p>
      <div className="mt-8">
        {cast.length ? <Residents residents={cast} /> : <p className="text-lichen">Nobody is awake yet. Start the Veridia service to meet them.</p>}
      </div>
    </div>
  );
}
