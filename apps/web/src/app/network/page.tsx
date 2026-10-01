import { services } from "@/lib/veridia";

export const dynamic = "force-dynamic";

type PoolState = { deposits: unknown[]; withdrawals: { processooor: string }[]; rezips: unknown[]; leaves: unknown[] };

async function numbers() {
  const get = (u: string) => fetch(u, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const [health, state, asp] = (await Promise.all([get(`${services.courier}/health`), get(`${services.courier}/state`), get(`${services.courier}/asp`)])) as [
    { courier: string; jobs: number; pendingRewards: string } | null,
    PoolState | null,
    { labels: unknown[] } | null,
  ];
  return { health, state, asp };
}

function Figure({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <dd className="font-story text-4xl tabular-nums tracking-tight">{value}</dd>
      <dt className="mt-1 text-sm text-lichen">{label}</dt>
    </div>
  );
}

export default async function Network() {
  const { health, state, asp } = await numbers();
  return (
    <div className="max-w-3xl pt-6">
      <h1 className="font-story text-4xl tracking-tight">How Veridia works</h1>
      <p className="mt-4 leading-relaxed text-pine/85">
        In <cite>Snowmoon</cite>, a payment is private by default, the sales tax reaches the government in real time, and people burn zipcoins
        so a message is worth reading. Here, each of those is a smart contract around one shared privacy pool on Ethereum, and every action
        adds to the crowd that hides everyone else.
      </p>

      <h2 className="mt-12 font-story text-2xl">The pool right now</h2>
      {state ? (
        <dl className="mt-5 grid grid-cols-2 gap-8 sm:grid-cols-4">
          <Figure value={state.deposits.length} label="notes ever zipped" />
          <Figure value={state.withdrawals.length} label="private spends" />
          <Figure value={state.rezips.length} label="sends that stayed inside" />
          <Figure value={asp?.labels.length ?? "?"} label="deposits cleared to spend" />
        </dl>
      ) : (
        <p className="mt-4 text-lichen">No courier is answering, so there are no live numbers. Start the local services to see them.</p>
      )}

      <h2 className="mt-12 font-story text-2xl">Couriers: the layer between you and the chain</h2>
      <p className="mt-4 leading-relaxed text-pine/85">
        Vitalik&apos;s <cite>The cryptographic world computer</cite> describes Ethereum growing a decentralized layer in the middle between users
        and the chain, one that is not itself a chain. Couriers are that layer for zipcoin. They stake ZC, carry your proof, hold it for a
        random while so its timing says nothing, and serve pool state anyone can check against the chain. If one promises to deliver and
        doesn&apos;t, its signed receipt gets part of its stake slashed.
      </p>
      {health && (
        <p className="mt-4 text-sm text-lichen">
          Courier {health.courier.slice(0, 10)}… is carrying {health.jobs} jobs so far.
        </p>
      )}

      <h2 className="mt-12 font-story text-2xl">Why there are residents at all</h2>
      <p className="mt-4 leading-relaxed text-pine/85">
        Privacy needs a crowd. A pool with six deposits hides nobody. Veridia&apos;s residents live their days on the same pool, so there is
        always ordinary traffic around a real person&apos;s payment. They only ever move coins through the pool and never trade the token. You
        can follow their story, but it is told a little late and leaves out the shop, the amount and the exact time, so it can&apos;t be
        matched to the transactions it describes.
      </p>
    </div>
  );
}
