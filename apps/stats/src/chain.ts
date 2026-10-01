import { createPublicClient, http, parseAbi, parseAbiItem, type Abi, type AbiEvent, type Address, type Hex } from "viem";

/**
 * Everything the stats service reads from the chain, behind one small interface so the tests can inject a fake chain.
 * Read-only: there is no key and nothing here can send a transaction.
 */
export type RawLog = { block: bigint; args: Record<string, unknown> };

export interface Chain {
  head(): Promise<bigint>;
  blockTime(block: bigint): Promise<number>;
  /** Logs of one event from one contract in [from, to]; `args` filters indexed topics as viem does */
  logs(address: Address, event: AbiEvent, from: bigint, to: bigint, args?: Record<string, unknown>): Promise<RawLog[]>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
  balance(address: Address): Promise<bigint>;
  storageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
}

export function rpcChain(rpcUrl: string): Chain {
  const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  return {
    head: () => pub.getBlockNumber({ cacheTime: 0 }),
    blockTime: async (block) => Number((await pub.getBlock({ blockNumber: block })).timestamp),
    logs: async (address, event, from, to, args) =>
      (await pub.getLogs({ address, event, fromBlock: from, toBlock: to, ...(args ? { args } : {}) } as Parameters<typeof pub.getLogs>[0])).map((l) => ({
        block: l.blockNumber!,
        args: ((l as unknown as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>,
      })),
    read: (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args: args as unknown[] }),
    balance: (address) => pub.getBalance({ address }),
    storageAt: (address, slot) => pub.getStorageAt({ address, slot }),
  };
}

/** The events the ledger, the privacy meter and the status page are built from */
export const EV = {
  poolDeposited: parseAbiItem("event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)"),
  poolWithdrawn: parseAbiItem("event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)"),
  poolRagequit: parseAbiItem("event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)"),
  poolHarvested: parseAbiItem("event Harvested(uint256 claimed, uint256 forwarded)"),
  taxSplit: parseAbiItem("event TaxSplit(uint256 burned, uint256 toCouriers, uint256 toTreasury)"),
  bandsDeposited: parseAbiItem("event Deposited(uint8 indexed band, uint256 indexed tokenId, uint128 liquidity, uint256 zcIn, address caller)"),
  bandsFees: parseAbiItem("event FeesCollected(uint8 indexed band, uint256 eth, uint256 zc)"),
  bandsEthToSafe: parseAbiItem("event EthToSafe(uint256 eth)"),
  bandsForwarded: parseAbiItem("event Forwarded(uint256 zc, uint256 eth)"),
  bandsWithdrawn: parseAbiItem("event Withdrawn(uint8 indexed band, uint128 liquidity, uint256 eth, uint256 zc)"),
  bonded: parseAbiItem("event Bonded(address indexed courier, uint256 stake, string endpoint)"),
  endpointSet: parseAbiItem("event EndpointSet(address indexed courier, string endpoint)"),
  rootUpdated: parseAbiItem("event RootUpdated(uint256 _root, string _ipfsCID, uint256 _timestamp)"),
  roleGranted: parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
  roleRevoked: parseAbiItem("event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
} as const;

export const ABI = {
  erc20: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  zcRewards: parseAbi(["function pendingReward(address holder) view returns (uint256)"]),
  safe: parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]),
  bands: parseAbi(["function SAFE() view returns (address)", "function paused() view returns (bool)"]),
  treasuryOf: parseAbi(["function TREASURY() view returns (address)"]),
  couriers: parseAbi([
    "function couriers(address) view returns (uint256 stake, uint64 unbondAt, string endpoint)",
    "function isActive(address) view returns (bool)",
    "function MIN_STAKE() view returns (uint256)",
  ]),
  pay: parseAbi(["function TAX_BPS() view returns (uint256)", "function BURN_SHARE_BPS() view returns (uint256)", "function COURIER_SHARE_BPS() view returns (uint256)"]),
} as const;

/** ERC-1967 implementation slot (a public constant of the standard): the Entrypoint is an upgradeable proxy */
export const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // guard:allow
