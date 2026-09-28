import clsx from "clsx";

// Deterministic resident portrait: one geometric face per seed,
// drawn in Veridia's winter palette. Shops get a doorway instead of a face.

const SIZES = { sm: "w-8 h-8", md: "w-12 h-12", lg: "w-20 h-20" } as const;
const TINTS = ["#496789", "#22A866", "#6E7A70", "#D6A01E", "#18241F"];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Portrait({ seed, shop, size = "md", lit, className }: { seed: string; shop?: boolean; size?: keyof typeof SIZES; lit?: boolean; className?: string }) {
  const h = hash(seed);
  const tint = TINTS[h % TINTS.length];
  const tilt = ((h >> 3) % 7) - 3;
  return (
    <span className={clsx(SIZES[size], "relative inline-block shrink-0 rounded-full bg-drift ring-1 ring-frost", lit && "ring-2 ring-pad", className)}>
      <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden>
        {shop ? (
          <>
            <rect x="18" y="16" width="28" height="36" rx="14" fill={tint} />
            <rect x="26" y="30" width="12" height="22" rx="6" fill="#ECF0EC" />
          </>
        ) : (
          <g transform={`rotate(${tilt} 32 32)`}>
            <circle cx="32" cy="26" r="11" fill={tint} />
            <path d="M14 56c2-12 9-18 18-18s16 6 18 18" fill={tint} opacity="0.75" />
            {h % 3 === 0 && <path d="M20 22c3-9 21-9 24 0" stroke="#18241F" strokeWidth="3" fill="none" opacity="0.6" />}
          </g>
        )}
      </svg>
    </span>
  );
}
