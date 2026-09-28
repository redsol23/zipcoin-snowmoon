import Link from "next/link";
import { notFound } from "next/navigation";

import { Portrait } from "@/components/Portrait";
import { VeridiaWorld } from "@/components/world/VeridiaWorld";
import { Chapter } from "@/components/World";
import { services, type Resident } from "@/lib/veridia";

export const dynamic = "force-dynamic";

export default async function ResidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cast = (await fetch(`${services.veridia}/cast`, { cache: "no-store" }).then((r) => r.json()).catch(() => [])) as Resident[];
  const r = cast.find((x) => x.id === id);
  if (!r) notFound();
  return (
    <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <aside>
        <Portrait seed={r.id} shop={!!r.shop} size="lg" />
        <h1 className="mt-4 font-story text-4xl tracking-tight">{r.name}</h1>
        <p className="mt-1 text-lichen">{r.shop ? `A shop in ${r.city}` : `Lives in ${r.city}`}</p>
        <p className="mt-4 max-w-md font-story text-lg leading-relaxed">{r.bio}</p>
        <VeridiaWorld residents={cast} focus={r.id} label={`${r.name}'s corner of Veridia`} className="mt-6 h-72 max-w-md" />
        <dl className="mt-8 space-y-3 text-sm">
          <div>
            <dt className="text-lichen">Public wallet</dt>
            <dd className="break-all">{r.wallet}</dd>
          </div>
          <div>
            <dt className="text-lichen">Zip address (for private sends)</dt>
            <dd className="break-all">{r.zipAddress}</dd>
          </div>
        </dl>
        <p className="mt-8 text-sm text-lichen">
          <Link href="/residents" className="underline underline-offset-2 hover:text-pine">
            All residents
          </Link>
        </p>
      </aside>
      <div>
        <h2 className="mb-2 font-story text-xl text-lichen">{r.name}&apos;s day</h2>
        <Chapter residents={cast} who={r.id} />
      </div>
    </div>
  );
}
