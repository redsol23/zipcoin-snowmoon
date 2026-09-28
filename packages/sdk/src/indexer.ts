import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

import { buildTree } from "./tree";

/**
 * Rebuilds the pool's public state from events. Anyone can run it; couriers serve its output and clients check the
 * result against on-chain roots (`pool.currentRoot()`, `entrypoint.latestRoot()`), so no server is trusted.
 */

export type DepositRow = { depositor: Address; commitment: bigint; label: bigint; value: bigint; precommitment: bigint; block: bigint; tx: Hex };
export type WithdrawRow = { processooor: Address; value: bigint; spentNullifier: bigint; newCommitment: bigint; block: bigint; tx: Hex };
export type RagequitRow = { ragequitter: Address; commitment: bigint; label: bigint; value: bigint; block: bigint };
export type RezipRow = { sender: Address; commitment: bigint; label: bigint; value: bigint; fee: bigint; ciphertext: Hex; block: bigint };

export type PoolState = {
  /** Every state-tree leaf in insertion order (deposits and change notes). */
  leaves: bigint[];
  deposits: DepositRow[];
  withdrawals: WithdrawRow[];
  ragequits: RagequitRow[];
  rezips: RezipRow[];
  head: bigint;
};

const ev = {
  leaf: parseAbiItem("event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)"),
  deposited: parseAbiItem("event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)"),
  withdrawn: parseAbiItem("event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)"),
  ragequit: parseAbiItem("event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)"),
  rezipped: parseAbiItem("event Rezipped(address indexed sender, uint256 indexed commitment, uint256 label, uint256 value, uint256 fee, bytes ciphertext)"),
};

export const emptyState = (): PoolState => ({ leaves: [], deposits: [], withdrawals: [], ragequits: [], rezips: [], head: 0n });

/** Fetches logs in chunks (public RPCs cap eth_getLogs ranges) and appends them to `state`. */
export async function syncPool(
  client: PublicClient,
  addr: { pool: Address; rezip: Address },
  state: PoolState,
  opts: { fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<PoolState> {
  // cacheTime 0: viem otherwise reuses the head for ~4s and a sync right after a tx would miss it
  const to = opts.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const chunk = opts.chunk ?? 5_000n;
  let from = state.head ? state.head + 1n : opts.fromBlock;
  while (from <= to) {
    const end = from + chunk - 1n > to ? to : from + chunk - 1n;
    const [leaves, deps, wds, rqs, rzs] = await Promise.all([
      client.getLogs({ address: addr.pool, event: ev.leaf, fromBlock: from, toBlock: end }),
      client.getLogs({ address: addr.pool, event: ev.deposited, fromBlock: from, toBlock: end }),
      client.getLogs({ address: addr.pool, event: ev.withdrawn, fromBlock: from, toBlock: end }),
      client.getLogs({ address: addr.pool, event: ev.ragequit, fromBlock: from, toBlock: end }),
      client.getLogs({ address: addr.rezip, event: ev.rezipped, fromBlock: from, toBlock: end }),
    ]);
    for (const l of leaves.sort((a, b) => Number(a.args._index! - b.args._index!))) state.leaves.push(l.args._leaf!);
    for (const l of deps)
      state.deposits.push({
        depositor: l.args._depositor!,
        commitment: l.args._commitment!,
        label: l.args._label!,
        value: l.args._value!,
        precommitment: l.args._precommitmentHash!,
        block: l.blockNumber,
        tx: l.transactionHash,
      });
    for (const l of wds)
      state.withdrawals.push({
        processooor: l.args._processooor!,
        value: l.args._value!,
        spentNullifier: l.args._spentNullifier!,
        newCommitment: l.args._newCommitment!,
        block: l.blockNumber,
        tx: l.transactionHash,
      });
    for (const l of rqs)
      state.ragequits.push({ ragequitter: l.args._ragequitter!, commitment: l.args._commitment!, label: l.args._label!, value: l.args._value!, block: l.blockNumber });
    for (const l of rzs)
      state.rezips.push({
        sender: l.args.sender!,
        commitment: l.args.commitment!,
        label: l.args.label!,
        value: l.args.value!,
        fee: l.args.fee!,
        ciphertext: l.args.ciphertext!,
        block: l.blockNumber,
      });
    state.head = end;
    from = end + 1n;
  }
  return state;
}

/** Checks a served state against the chain: the rebuilt tree must match the pool's current root. */
export async function verifyState(client: PublicClient, pool: Address, state: PoolState): Promise<boolean> {
  const onchain = (await client.readContract({
    address: pool,
    abi: [parseAbiItem("function currentRoot() view returns (uint256)")],
    functionName: "currentRoot",
  })) as bigint;
  return state.leaves.length === 0 ? onchain === 0n : buildTree(state.leaves).root === onchain;
}
