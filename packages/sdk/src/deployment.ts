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
};

export function parseDeployment(json: string | Record<string, unknown>): Deployment {
  const d = (typeof json === "string" ? JSON.parse(json) : json) as Record<string, unknown>;
  return { ...(d as unknown as Deployment), chainId: Number(d.chainId), deployBlock: Number(d.deployBlock), scope: BigInt(d.scope as string) };
}
