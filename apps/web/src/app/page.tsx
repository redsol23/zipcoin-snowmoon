import { VeridiaWorld } from "@/components/world/VeridiaWorld";
import { Chapter, Residents } from "@/components/World";
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
    <div className="pt-4">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div>
          <p className="font-story text-lg italic text-lichen">{veridianDate()}</p>
          <h1 className="mt-1 max-w-2xl font-story text-[2.3rem] leading-[1.08] tracking-tight sm:text-[2.8rem]">
            Only the diner and the restaurant know what was ordered.
          </h1>
        </div>
        <p className="max-w-md leading-relaxed text-pine/85">
          The people of <cite>Snowmoon</cite> go about their day on zipcoin. Every meal, allowance and anonymous note you see is a real
          zero-knowledge proof on Ethereum. The chain doesn&apos;t know who did what, and the story, told a little late and without the
          details, doesn&apos;t give it away.
        </p>
      </div>

      <VeridiaWorld residents={cast} className="mt-6 h-[58vh] min-h-[380px] max-h-[720px]" />
      <p className="mt-3 max-w-3xl text-[0.82rem] leading-relaxed text-lichen">
        A pad glows green when someone pays privately, and the sales tax splits on the spot: a little burned, a share sent to the couriers.
        Gold sparks mean coins burned at a door, and a rising lantern is a message someone paid to be heard. Couriers in slate cloaks carry
        sealed proofs and hold them a while before sending, so unsigned notes on the board and answers in Freetown&apos;s square arrive from
        nobody in particular. Light travels between homes when someone sends an allowance. Day, night and weather follow your clock. Drag to
        look around; tap anyone, or any place, to see who they are and what they did lately. The story runs a little behind the chain.
      </p>

      <div className="mt-14 grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <h2 className="mb-4 font-story text-xl text-lichen">Who lives here</h2>
          {cast.length ? <Residents residents={cast} /> : <p className="text-lichen">Nobody is awake yet.</p>}
        </aside>
        <div>
          <h2 className="mb-2 font-story text-xl text-lichen">Today in Veridia</h2>
          <Chapter residents={cast} />
        </div>
      </div>
    </div>
  );
}
