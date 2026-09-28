/**
 * Foundry FFI entrypoint: prints an ABI-encoded proof tuple to stdout.
 *
 *   spend <value> <label> <nullifier> <secret> <newNullifier> <newSecret> <amount> <context> <stateLeavesHex> <aspLeavesHex>
 *   exit  <value> <label> <nullifier> <secret>
 *   root  <leavesHex>
 *   identity  <secret>                                     (Semaphore identity commitment)
 *   semaphore <secret> <membersHex> <message> <scope>        (Semaphore v4 proof)
 *
 * Leaves are `abi.encode(uint256[])`. snarkjs logs to stdout, so it is silenced while proving.
 */
import { generateProof, Group, Identity } from "@semaphore-protocol/core";
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";

import { buildTree, hashCommitment, hashPrecommitment, proveExit, proveLeaf, proveSpend } from "../src/index";

const write = process.stdout.write.bind(process.stdout);
const silent = async <T>(fn: () => Promise<T>) => {
  process.stdout.write = (() => true) as never;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
};

const leaves = (hex: string) => [...decodeAbiParameters([{ type: "uint256[]" }], hex as Hex)[0]];

const proofTuple = (n: number) =>
  [
    {
      type: "tuple",
      components: [
        { name: "pA", type: "uint256[2]" },
        { name: "pB", type: "uint256[2][2]" },
        { name: "pC", type: "uint256[2]" },
        { name: "pubSignals", type: `uint256[${n}]` },
      ],
    },
  ] as const;

async function main() {
  const [mode, ...a] = process.argv.slice(2);
  if (mode === "spend") {
    const [value, label, nullifier, secret, newNullifier, newSecret, amount, ctx] = a.slice(0, 8).map(BigInt);
    const leaf = hashCommitment(value, label, hashPrecommitment(nullifier, secret));
    const p = await silent(() =>
      proveSpend({
        value,
        label,
        nullifier,
        secret,
        newNullifier,
        newSecret,
        amount,
        context: ctx,
        state: proveLeaf(leaves(a[8]), leaf),
        asp: proveLeaf(leaves(a[9]), label),
      }),
    );
    write(encodeAbiParameters(proofTuple(8), [p as never]));
  } else if (mode === "identity") {
    write(encodeAbiParameters([{ type: "uint256" }], [new Identity(a[0]).commitment]));
  } else if (mode === "semaphore") {
    const p = await silent(() => generateProof(new Identity(a[0]), new Group(leaves(a[1])), BigInt(a[2]), BigInt(a[3])));
    write(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "merkleTreeDepth", type: "uint256" },
              { name: "merkleTreeRoot", type: "uint256" },
              { name: "nullifier", type: "uint256" },
              { name: "message", type: "uint256" },
              { name: "scope", type: "uint256" },
              { name: "points", type: "uint256[8]" },
            ],
          },
        ],
        [
          {
            merkleTreeDepth: BigInt(p.merkleTreeDepth),
            merkleTreeRoot: BigInt(p.merkleTreeRoot),
            nullifier: BigInt(p.nullifier),
            message: BigInt(p.message),
            scope: BigInt(p.scope),
            points: p.points.map(BigInt) as never,
          },
        ],
      ),
    );
  } else if (mode === "root") {
    write(encodeAbiParameters([{ type: "uint256" }], [buildTree(leaves(a[0])).root]));
  } else if (mode === "exit") {
    const [value, label, nullifier, secret] = a.map(BigInt);
    const p = await silent(() => proveExit(value, label, nullifier, secret));
    write(encodeAbiParameters(proofTuple(4), [p as never]));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
