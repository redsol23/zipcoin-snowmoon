import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, numberToBytes, parseAbi, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { zcRewardsHarvesterAbi } from "./abi";
import type { Deployment } from "./deployment";
import type { MasterKeys } from "./keys";

/**
 * ETH holder rewards. ZC pays every holder ETH, including the zipnet contracts that hold ZC for people. Those contracts
 * pass it on: the privacy pool sends its share to the treasury, and merchant stakes, courier bonds and badge locks
 * (ZcRewardsHarvester) share theirs among their stakers pro rata by stake over time. Anyone may `harvest()` a
 * contract, and couriers do it once enough ETH has built up to be worth the gas.
 */

/** The ZC token's reward surface (LaunchToken) */
export const zcRewardsAbi = parseAbi([
  "function pendingReward(address holder) view returns (uint256)",
  "function claim() returns (uint256)",
  "error NothingToClaim()",
  "error RewardTransferFailed()",
]);

/** harvest() as every harvestable contract has it, with the token's errors so a NothingToClaim revert decodes */
export const harvestAbi = [...zcRewardsHarvesterAbi, ...zcRewardsAbi] as const;

/**
 * Every contract with a harvest(): the pool (to the treasury), the staking contracts (to their stakers), and the poll
 * escrow (to the pool's treasury). Contracts absent from the deployment are skipped.
 */
export const harvestTargets = (dep: Deployment): Address[] =>
  [dep.pool, dep.merchants, dep.couriers, dep.badges, dep.polls].filter(
    (a): a is Address => !!a && !/^0x0{40}$/i.test(a),
  );

/** Contracts that share ETH with their stakers and have pendingEth/claimEth */
export type EthStaking = "merchants" | "couriers" | "badges";

/** ETH the token holds for `holder` that nobody has harvested yet (0 if the token pays no rewards) */
export async function zcPendingReward(client: PublicClient, dep: Deployment, holder: Address): Promise<bigint> {
  try {
    return (await client.readContract({ address: dep.zc, abi: zcRewardsAbi, functionName: "pendingReward", args: [holder] })) as bigint;
  } catch {
    return 0n;
  }
}

/** ETH `account` can claim from a staking contract, including ETH not yet harvested */
export async function pendingEth(client: PublicClient, dep: Deployment, contract: EthStaking, account: Address): Promise<bigint> {
  return (await client.readContract({ address: dep[contract], abi: zcRewardsHarvesterAbi, functionName: "pendingEth", args: [account] })) as bigint;
}

/**
 * Call parameters that pay `account` its ETH from a staking contract: `claimEth()` when the caller is the account,
 * `claimEthFor(account)` otherwise (the ETH always goes to `account`).
 */
export function claimEthCall(dep: Deployment, contract: EthStaking, account?: Address) {
  return account
    ? ({ address: dep[contract], abi: zcRewardsHarvesterAbi, functionName: "claimEthFor", args: [account] } as const)
    : ({ address: dep[contract], abi: zcRewardsHarvesterAbi, functionName: "claimEth", args: [] } as const);
}

/**
 * The address that earns a zip key's badge-lock ETH (the lock's `rewardTo`). Derived from the master secret, so it is
 * recoverable from the key and linked to no wallet; its ETH can be claimed for it by anyone (a courier) and then spent
 * with this account.
 *
 * With `index` (the lock's index, as for `badgeLockIdentity` and `badgeReturnSecrets`) it is one address per lock
 * (I-3): ZipBadges keeps `lockRewardTo` public, so one address shared by all of a key's locks would link locks that
 * per-lock identities keep apart (A-7). Without `index` it is the one-per-key address that older locks named.
 */
export function badgeRewardAccount(k: MasterKeys, index?: bigint) {
  const info = index === undefined ? "zipnet badge eth v1" : `zipnet badge eth v1/${index}`;
  const sk = hkdf(sha256, numberToBytes(k.masterSecret, { size: 32 }), undefined, new TextEncoder().encode(info), 32);
  return privateKeyToAccount(bytesToHex(sk));
}
