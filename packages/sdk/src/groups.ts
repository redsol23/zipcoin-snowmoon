import { parseAbiItem, type Address, type PublicClient } from "viem";

/**
 * Rebuilds a Semaphore group's leaves (insertion order, 0 for removed members) from events, which is what a member
 * needs to generate a membership proof. Works for any group: badge tiers, merchant payer groups.
 */
const ev = {
  added: parseAbiItem("event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)"),
  addedMany: parseAbiItem("event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)"),
  updated: parseAbiItem(
    "event MemberUpdated(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 newIdentityCommitment, uint256 merkleTreeRoot)",
  ),
  removed: parseAbiItem("event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)"),
};

export async function groupMembers(client: PublicClient, semaphore: Address, groupId: bigint, fromBlock = 0n): Promise<bigint[]> {
  const q = { address: semaphore, args: { groupId }, fromBlock } as const;
  const [a, m, u, r] = await Promise.all([
    client.getLogs({ ...q, event: ev.added }),
    client.getLogs({ ...q, event: ev.addedMany }),
    client.getLogs({ ...q, event: ev.updated }),
    client.getLogs({ ...q, event: ev.removed }),
  ]);
  const leaves: bigint[] = [];
  for (const l of a) leaves[Number(l.args.index!)] = l.args.identityCommitment!;
  for (const l of m) l.args.identityCommitments!.forEach((c, i) => (leaves[Number(l.args.startIndex!) + i] = c));
  const order = (x: { blockNumber: bigint; logIndex: number }) => Number(x.blockNumber) * 1e6 + x.logIndex;
  const edits = [
    ...u.map((l) => ({ at: order(l), index: Number(l.args.index!), value: l.args.newIdentityCommitment! })),
    ...r.map((l) => ({ at: order(l), index: Number(l.args.index!), value: 0n })),
  ].sort((x, y) => x.at - y.at);
  for (const e of edits) leaves[e.index] = e.value;
  return Array.from(leaves, (x) => x ?? 0n);
}
