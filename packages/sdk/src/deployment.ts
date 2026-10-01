import type { Address } from "viem";

/** Shape of contracts/deployments/<name>.json written by script/Deploy.s.sol. */
export type Deployment = {
  chainId: number;
  deployBlock: number;
  zc: Address;
  entrypoint: Address;
  pool: Address;
  scope: bigint;
  semaphore: Address;
  broadcaster: Address;
  doorstep: Address;
  rezip: Address;
  addressRegistry: Address;
  merchants: Address;
  couriers: Address;
  pay: Address;
  badges: Address;
  signal: Address;
  polls: Address;
  /** Upstream BatchRelayer (absent in deployments made before it was added) */
  batchRelayer?: Address;
  /** ZipLiquidityBands: the treasury liquidity bands (absent unless deployed with the pool config) */
  bands?: Address;
};

const OPTIONAL = ["batchRelayer", "bands"] as const;
const ZERO = /^0x0{40}$/i;

export function parseDeployment(json: string | Record<string, unknown>): Deployment {
  const d = { ...((typeof json === "string" ? JSON.parse(json) : json) as Record<string, unknown>) };
  // A skipped contract may be written as the zero address; treat it like a missing key
  for (const k of OPTIONAL) if (typeof d[k] !== "string" || ZERO.test(d[k] as string)) delete d[k];
  return { ...(d as unknown as Deployment), chainId: Number(d.chainId), deployBlock: Number(d.deployBlock), scope: BigInt(d.scope as string) };
}
