/// <reference path="./snarkjs.d.ts" />
/**
 * Proving for Privacy Pools spends and exits. `context` is the pool's own check
 * (`keccak256(abi.encode(withdrawal, SCOPE)) % SNARK_SCALAR_FIELD`, PrivacyPool.sol), and the circuit inputs follow
 * `prepareInputSignals` in @0xbow/privacy-pools-core-sdk (Apache-2.0).
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import { SNARK_SCALAR_FIELD, type TreeProof } from "./tree";

export type Withdrawal = { processooor: Address; data: Hex };

export type SolidityProof<N extends number> = {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
  pubSignals: bigint[] & { length: N };
};

/** The proof's `context` signal: binds processooor + data (+ scope) so nobody can alter them after proving. */
export function context(w: Withdrawal, scope: bigint) {
  const enc = encodeAbiParameters(
    [
      { type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] },
      { type: "uint256" },
    ],
    [{ processooor: w.processooor, data: w.data }, scope],
  );
  return BigInt(keccak256(enc)) % SNARK_SCALAR_FIELD;
}

/**
 * Ceremony artifacts: `<dir>/{withdraw,commitment}.{wasm,zkey}`, SHA-256 identical to the ones pinned by
 * @0xbow/privacy-pools-core-sdk. We call snarkjs directly: the SDK's bundled prover hangs on Windows.
 */
let artifactsDir: string | null = typeof window === "undefined" ? null : `${window.location.origin}/artifacts/`;

/** In Node the artifacts ship with this package; resolved lazily so browser bundles never load node:url. */
async function dir() {
  if (artifactsDir) return artifactsDir;
  const { fileURLToPath } = await import(/* webpackIgnore: true */ "node:url");
  const rel = ["..", "artifacts", "artifacts", ""].join("/"); // not a literal, so bundlers leave it alone
  artifactsDir = fileURLToPath(new URL(rel, import.meta.url));
  return artifactsDir;
}

export const setArtifactsDir = (dir: string) => {
  artifactsDir = dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + "/";
};

async function fullProve(circuit: "withdraw" | "commitment", input: Record<string, unknown>) {
  const snarkjs = await import("snarkjs");
  const d = await dir();
  return snarkjs.groth16.fullProve(input as never, d + circuit + ".wasm", d + circuit + ".zkey");
}

type Groth16 = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

/**
 * snarkjs → Solidity verifier layout. G1 points drop their projective z; each G2 coordinate is an Fp2 element that
 * snarkjs writes as [c0, c1] and the EVM pairing precompile reads as [c1, c0].
 */
function toSolidity<N extends number>(proof: Groth16, publicSignals: string[]): SolidityProof<N> {
  const g1 = (p: string[]): [bigint, bigint] => [BigInt(p[0]), BigInt(p[1])];
  const fp2 = (c: string[]): [bigint, bigint] => [BigInt(c[1]), BigInt(c[0])];
  return {
    pA: g1(proof.pi_a),
    pB: [fp2(proof.pi_b[0]), fp2(proof.pi_b[1])],
    pC: g1(proof.pi_c),
    pubSignals: publicSignals.map(BigInt) as bigint[] & { length: N },
  };
}

export type SpendInput = {
  value: bigint;
  label: bigint;
  nullifier: bigint;
  secret: bigint;
  /** Secrets of the change note left in the pool (value - amount). */
  newNullifier: bigint;
  newSecret: bigint;
  amount: bigint;
  context: bigint;
  state: TreeProof;
  asp: TreeProof;
};

/** Groth16 withdrawal proof against the 0xbow ceremony keys. Output feeds `PrivacyPool.withdraw`. */
export async function proveSpend(i: SpendInput): Promise<SolidityProof<8>> {
  const { proof, publicSignals } = await fullProve("withdraw", {
    withdrawnValue: i.amount,
    stateRoot: i.state.root,
    stateTreeDepth: i.state.depth,
    ASPRoot: i.asp.root,
    ASPTreeDepth: i.asp.depth,
    context: i.context,
    label: i.label,
    existingValue: i.value,
    existingNullifier: i.nullifier,
    existingSecret: i.secret,
    newNullifier: i.newNullifier,
    newSecret: i.newSecret,
    stateSiblings: i.state.siblings,
    stateIndex: i.state.index,
    ASPSiblings: i.asp.siblings,
    ASPIndex: i.asp.index,
  });
  return toSolidity<8>(proof as unknown as Groth16, publicSignals as string[]);
}

/** Proof for a public exit to the original depositor (ragequit). */
export async function proveExit(value: bigint, label: bigint, nullifier: bigint, secret: bigint): Promise<SolidityProof<4>> {
  const { proof, publicSignals } = await fullProve("commitment", { value, label, nullifier, secret });
  return toSolidity<4>(proof as unknown as Groth16, publicSignals as string[]);
}
