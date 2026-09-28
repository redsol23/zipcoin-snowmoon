import { Chapter, CityMap } from "@/components/World";
import { services, veridianDate, type Resident } from "@/lib/veridia";

export const dynamic = "force-dynamic";

async function residents(): Promise<Resident[]> {
  try {
    return (await (await fetch(`${services.veridia}/cast`, { cache: "no-store" })).json()) as Resident[];
  } catch {
    return [];
  }
}

export default async function Today() {
  const cast = await residents();
  return (
    <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <p className="font-story text-lg italic text-lichen">{veridianDate()}</p>
        <h1 className="mt-1 max-w-md font-story text-[2.6rem] leading-[1.08] tracking-tight">
          Only the diner and the restaurant know what was ordered.
        </h1>
        <p className="mt-4 max-w-md leading-relaxed text-pine/85">
          The people of <cite>Snowmoon</cite> go about their day on zipcoin. Every meal, allowance and anonymous note below is a real
          zero-knowledge proof on Ethereum. The story knows who did what. The chain doesn&apos;t.
        </p>
        <div className="mt-8">
          <CityMap residents={cast} />
        </div>
      </aside>
      <div>
        <h2 className="mb-2 font-story text-xl text-lichen">Today in Veridia</h2>
        <Chapter residents={cast} />
      </div>
    </div>
  );
}
