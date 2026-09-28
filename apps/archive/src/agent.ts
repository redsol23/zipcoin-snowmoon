/**
 * An AI-agent-style client that buys Mountain Archive entries with private x402 payments.
 *
 * It holds a zip key (from AGENT_MNEMONIC) and ZC it zipped earlier; when the archive answers 402 it pays from a note
 * through a courier and retries. The archive sees paid orders, never the agent's wallet.
 *
 *   AGENT_MNEMONIC=... AGENT_KEY=0x... (only for the one-time zip) node --import tsx src/agent.ts
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { depositSecrets, entrypointAbi, hashPrecommitment, masterKeys, parseDeployment, parsePoolState, recoverNotes, zipAddressKeys, type PoolState } from "@zipnet/sdk";
import { notePayer, payingFetch } from "@zipnet/x402";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const dep = parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const pub = createPublicClient({ transport: http(env("RPC_URL")) });
const courierUrl = env("COURIER_URL", "http://127.0.0.1:8720");
const archiveUrl = env("ARCHIVE_URL", "http://127.0.0.1:8740");
const keys = masterKeys(env("AGENT_MNEMONIC"));
const zipKey = zipAddressKeys(keys.masterSecret).privateKey;

async function cleared() {
  const state = parsePoolState<PoolState>(await (await fetch(`${courierUrl}/state`)).text());
  const labels = ((await (await fetch(`${courierUrl}/asp`)).json()) as { labels: string[] }).labels.map(BigInt);
  const r = recoverNotes(keys, dep.scope, state, { zipAddressKey: zipKey });
  return { ...r, cleared: r.notes.filter((n) => labels.includes(n.label)).reduce((a, n) => a + n.value, 0n) };
}

// One-time: zip some ZC from the agent's wallet, then wait for the postman to clear it
let mine = await cleared();
if (mine.cleared === 0n) {
  const account = privateKeyToAccount(env("AGENT_KEY") as Hex);
  const wallet = createWalletClient({ account, transport: http(env("RPC_URL")) });
  const amount = parseEther(env("AGENT_ZIP_ZC", "50"));
  const erc20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;
  if (mine.balance === 0n) {
    const s = depositSecrets(keys, dep.scope, mine.nextDepositIndex);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "approve", args: [dep.entrypoint, amount] }) });
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ chain: null, address: dep.entrypoint, abi: entrypointAbi, functionName: "deposit", args: [dep.zc, amount, hashPrecommitment(s.nullifier, s.secret)] }),
    });
    console.log(`[agent] zipped ${env("AGENT_ZIP_ZC", "50")} ZC; waiting for it to clear`);
  }
  while ((mine = await cleared()).cleared === 0n) await new Promise((ok) => setTimeout(ok, 3000));
}
console.log(`[agent] ${mine.cleared / 10n ** 18n} ZC zipped and cleared`);

const fetchPaid = payingFetch(notePayer({ pub, deployment: dep, keys, zipAddressKey: zipKey, courierUrl }), { maxBase: parseEther("10"), calls: 4 });
for (let i = 0; i < 5; i++) {
  const res = await fetchPaid(`${archiveUrl}/entry`);
  const left = res.headers.get("x-payment-response");
  const callsLeft = left ? (JSON.parse(Buffer.from(left, "base64").toString()) as { callsLeft: number }).callsLeft : "?";
  console.log(`[agent] ${res.status} ${JSON.stringify(await res.json())} (calls left on this payment: ${callsLeft})`);
}
process.exit(0);
