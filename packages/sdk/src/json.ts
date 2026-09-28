/** JSON with bigints as decimal strings, for couriers serving state and proofs over HTTP. */
export const toJson = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const BIG = /^-?\d{16,}$|^\d+n$/;

/** Parses JSON produced by `toJson`, turning long numeric strings back into bigints for the listed keys. */
export function fromJson<T>(s: string, bigKeys: string[]): T {
  const keys = new Set(bigKeys);
  return JSON.parse(s, (k, v) => {
    if (typeof v === "string" && (keys.has(k) || (/^\d+$/.test(k) && BIG.test(v)))) return BigInt(v);
    if (Array.isArray(v) && keys.has(k)) return v.map((x) => (typeof x === "string" ? BigInt(x) : x));
    return v;
  }) as T;
}

/** Withdrawal proof public signals, in ProofLib order. */
export const proofSignals = (pubSignals: readonly bigint[]) => ({
  newCommitment: pubSignals[0],
  nullifierHash: pubSignals[1],
  value: pubSignals[2],
  stateRoot: pubSignals[3],
  stateTreeDepth: pubSignals[4],
  aspRoot: pubSignals[5],
  aspTreeDepth: pubSignals[6],
  context: pubSignals[7],
});

const POOL_BIG_KEYS = ["leaves", "commitment", "label", "value", "precommitment", "block", "spentNullifier", "newCommitment", "fee", "head"];

/** Parses a courier's GET /state body back into a PoolState. */
export const parsePoolState = <T>(json: string) => fromJson<T>(json, POOL_BIG_KEYS);
