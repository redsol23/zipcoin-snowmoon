/**
 * Courier upgrades against a live local stack: two bonded couriers, stake-weighted choice, private reads (chunks,
 * delta, ETag), a sealed two-hop unzip, and a combined-notes unzip through the BatchRelayer.
 *   local-up.sh, then the postman and two couriers (COURIER_A / COURIER_B, default :8721 / :8722), then
 *   node node_modules/tsx/dist/cli.mjs test/upgrades-live.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  buildTree,
  context,
  depositSecrets,
  encodeBatchRelay,
  encodeRelay,
  entrypointAbi,
  hashPrecommitment,
  listCouriers,
  masterKeys,
  parseDeployment,
  pickCouriers,
  proveLeaf,
  proveSpend,
  recoverNotes,
  sendSealed,
  syncFromCourier,
  toJson,
  withdrawalSecrets,
  type Note,
  type PoolState,
} from "../src/index";

const root = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".local/dev.env"), "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const dep = parseDeployment(fs.readFileSync(path.resolve(root, env.DEPLOYMENT), "utf8"));
const dev = privateKeyToAccount(env.DEV_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: foundry, transport: http(env.RPC_URL) });
const wallet = createWalletClient({ account: dev, chain: foundry, transport: http(env.RPC_URL) });
const A = process.env.COURIER_A ?? "http://127.0.0.1:8721";
const B = process.env.COURIER_B ?? "http://127.0.0.1:8722";
const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const rootAbi = [{ type: "function", name: "currentRoot", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;

const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zc = (v: bigint) => Number(v / 10n ** 15n) / 1000;
const balanceOf = (a: Address) => pub.readContract({ address: dep.zc, abi: erc20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, sec = 150): Promise<T> {
  for (let i = 0; i < sec; i++) {
    const v = await f().catch(() => null);
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const asp = async (url: string) => ((await (await fetch(`${url}/asp`)).json()) as { labels: string[] }).labels.map(BigInt);

async function prove(note: Note, amount: bigint, processooor: Address, data: Hex, state: PoolState, labels: bigint[]) {
  const next = withdrawalSecrets(keys, note.label, note.children);
  return proveSpend({
    value: note.value,
    label: note.label,
    nullifier: note.nullifier,
    secret: note.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor, data }, dep.scope),
    state: proveLeaf(state.leaves, note.commitment),
    asp: proveLeaf(labels, note.label),
  });
}

const keys = masterKeys("legal winner thank year wave sausage worth useful legal winner thank yellow");

async function main() {
  const t0 = Date.now();

  console.log("courier choice");
  const list = await listCouriers(pub, dep.couriers, BigInt(dep.deployBlock));
  const active = list.filter((c) => c.active);
  ok(active.length >= 2, `${active.length} bonded couriers found in the registry`);
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const c = pickCouriers(list, 1)[0];
    counts.set(c.endpoint, (counts.get(c.endpoint) ?? 0) + 1);
  }
  const total = active.reduce((a, c) => a + c.stake, 0n);
  for (const c of active) console.log(`      ${c.endpoint}: stake ${zc(c.stake)} ZC, share ${Number((c.stake * 1000n) / total) / 10}%, drawn ${(counts.get(c.endpoint) ?? 0) / 20}%`);

  console.log("private reads");
  let state = await syncFromCourier(A);
  const onchain = await pub.readContract({ address: dep.pool, abi: rootAbi, functionName: "currentRoot" });
  ok(state.leaves.length === 0 || buildTree(state.leaves).root === onchain, `cold chunked sync (${state.leaves.length} leaves) matches the on-chain root`);
  const r1 = await fetch(`${A}/state`);
  const etag = r1.headers.get("etag");
  ok(etag, `/state carries an ETag ${etag}`);
  const r2 = await fetch(`${A}/state`, { headers: { "if-none-match": etag! } });
  ok(r2.status === 304 || r2.headers.get("etag") !== etag, `unchanged state answers ${r2.status} to If-None-Match`);

  console.log("zip two notes");
  const idx = recoverNotes(keys, dep.scope, state).nextDepositIndex;
  const secrets = [depositSecrets(keys, dep.scope, idx), depositSecrets(keys, dep.scope, idx + 1n)];
  const amounts = [parseEther("70"), parseEther("50")];
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, parseEther("120")] }) });
  for (let i = 0; i < 2; i++) {
    const hash = await wallet.writeContract({
      address: dep.entrypoint,
      abi: entrypointAbi,
      functionName: "deposit",
      args: [dep.zc, amounts[i], hashPrecommitment(secrets[i].nullifier, secrets[i].secret)],
    });
    await pub.waitForTransactionReceipt({ hash });
  }
  const before = state;
  state = await until("the courier to index the deposits", async () => {
    const s = await syncFromCourier(B, before);
    return recoverNotes(keys, dep.scope, s).notes.filter((n) => secrets.some((x) => x.nullifier === n.nullifier)).length === 2 && s;
  });
  ok(buildTree(state.leaves).root === (await pub.readContract({ address: dep.pool, abi: rootAbi, functionName: "currentRoot" })), "warm delta sync from the other courier matches the on-chain root");
  let notes = recoverNotes(keys, dep.scope, state).notes.filter((n) => secrets.some((x) => x.nullifier === n.nullifier));
  let labels = await until("the postman to clear both notes", async () => {
    const l = await asp(B);
    return notes.every((n) => l.includes(n.label)) && l;
  });
  // The courier checks proofs against the on-chain ASP root; wait until it reflects the served labels
  await until("the ASP root on-chain", async () => (await pub.readContract({ address: dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" })) === buildTree(labels).root);
  ok(true, "both notes cleared by the postman");

  console.log("sealed two-hop unzip (first hop A, destination B)");
  const quoteB = (await (await fetch(`${B}/quote`)).json()) as { courier: Address; encryptionKey: Hex };
  const dest1 = privateKeyToAccount(generatePrivateKey()).address;
  const big = notes.find((n) => n.value === parseEther("70"))!;
  const relayData = encodeRelay(dest1, quoteB.courier, 0n);
  const proof = await prove(big, parseEther("10"), dep.entrypoint, relayData, state, labels);
  const job = await sendSealed(A, { url: B, encryptionKey: quoteB.encryptionKey }, { kind: "relay", holdSec: 0, withdrawal: { processooor: dep.entrypoint, data: relayData }, proof });
  ok(job.id, `destination accepted job ${job.id} (${job.status}); A only saw an envelope`);
  await until("the unzip to land", async () => (await balanceOf(dest1)) === parseEther("10"));
  ok(true, "10 ZC arrived at a fresh address");
  const aLog = fs.readFileSync(path.join(root, ".local/courier-a.log"), "utf8");
  ok(!aLog.includes(job.id), "first hop never logged the job");

  const wrongKey = await fetch(`${A}/relay-hop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "http://example.com", envelope: "0x00" }) });
  ok(wrongKey.status === 400, `first hop refuses a destination that isn't a bonded courier (${wrongKey.status})`);

  console.log("combined-notes unzip through the BatchRelayer");
  const prevState = state;
  state = await until("the change note", async () => {
    const s = await syncFromCourier(A, prevState);
    const n = recoverNotes(keys, dep.scope, s).notes.find((x) => x.label === big.label);
    return n && n.value === parseEther("60") && s;
  });
  notes = recoverNotes(keys, dep.scope, state).notes.filter((n) => notes.some((x) => x.label === n.label));
  labels = await asp(A);
  const dest2 = privateKeyToAccount(generatePrivateKey()).address;
  const quoteA = (await (await fetch(`${A}/quote`)).json()) as { courier: Address };
  const batchData = encodeBatchRelay({ recipient: dest2, feeRecipient: quoteA.courier, relayFeeBPS: 0n, batchSize: 2, totalValue: parseEther("100") });
  const parts = [
    { note: notes.find((n) => n.value === parseEther("60"))!, amount: parseEther("60") },
    { note: notes.find((n) => n.value === parseEther("50"))!, amount: parseEther("40") },
  ];
  const proofs = [];
  for (const p of parts) proofs.push(await prove(p.note, p.amount, dep.batchRelayer!, batchData, state, labels));
  const res = await fetch(`${A}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind: "batch", holdSec: 0, withdrawal: { processooor: dep.batchRelayer, data: batchData }, proofs }),
  });
  const bj = await res.json();
  ok(res.ok, `courier accepted the batch job (${res.status} ${bj.error ?? bj.status})`);
  await until("the combined unzip to land", async () => (await balanceOf(dest2)) === parseEther("100"));
  ok(true, "100 ZC from two notes (more than either holds) arrived in one transaction");

  console.log(`all ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
