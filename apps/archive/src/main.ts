/**
 * The Mountain Archive: a demo API that sells its answers per call, paid privately in zipcoin over x402.
 *
 * In Snowmoon, a digital archive node inside a mountain holds the files people burn zipcoins to point each other to.
 * Here the archive is a listed merchant: every answer costs a little ZC plus sales tax, paid from a zipped note, so the
 * archive knows it was paid and never learns who asked.
 *
 *   GET /           what the archive is and what it charges (free)
 *   GET /entry      one archive entry (paid: x402, scheme "zipnet")
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicClient, createWalletClient, http as httpTransport, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { parseDeployment, zipMerchantsAbi } from "@zipnet/sdk";
import { paywall } from "@zipnet/x402";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const dep = parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const rpc = env("RPC_URL");
const account = privateKeyToAccount(env("ARCHIVE_KEY") as Hex);
const dataDir = env("DATA_DIR", path.resolve(".archive"));
const port = Number(env("PORT", "8740"));
const price = parseEther(env("PRICE_ZC", "0.5"));
fs.mkdirSync(dataDir, { recursive: true });

const pub = createPublicClient({ transport: httpTransport(rpc) });
const wallet = createWalletClient({ account, transport: httpTransport(rpc) });
const erc20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;

/** Lists the archive as a merchant once (stake from its wallet); the id is remembered. */
async function merchantId(): Promise<bigint> {
  const file = path.join(dataDir, "merchant.json");
  if (fs.existsSync(file)) return BigInt(JSON.parse(fs.readFileSync(file, "utf8")).id);
  const stake = (await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "MIN_STAKE" })) as bigint;
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: dep.zc, abi: erc20, functionName: "approve", args: [dep.merchants, stake] }) });
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ chain: null, address: dep.merchants, abi: zipMerchantsAbi, functionName: "register", args: [account.address, stake, "veridia:The Mountain Archive"] }),
  });
  const id = (await pub.readContract({ address: dep.merchants, abi: zipMerchantsAbi, functionName: "merchantCount" })) as bigint;
  fs.writeFileSync(file, JSON.stringify({ id: id.toString() }));
  return id;
}

const ENTRIES = [
  "Index 12: tax rubrics for the Kalimar district, with the aesthetics scores of every street since the forest paths were planted.",
  "Index 31: a courier's log of relayed messages, counts only. Nobody kept the senders.",
  "Index 47: the Beautiful Plants menu across three winters. Number Ten changed twice.",
  "Index 58: minutes of a citizens' assembly on how long algorithm changes must wait. They settled on twenty days.",
  "Index 73: maps of the tunnel network under the mountain, including the door with the river horse reading a book.",
  "Index 88: a ledger of burns at public doorsteps, by size. The largest single burn was four hundred zipcoins.",
  "Index 104: notes on social recovery. Test your guardians before you need them.",
];

const id = await merchantId();
const charge = paywall({
  pub,
  deployment: dep,
  merchantId: id,
  pricePerCall: price,
  suggestedCalls: 10,
  description: "One entry from the Mountain Archive",
  ledgerFile: path.join(dataDir, "ledger.json"),
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ name: "The Mountain Archive", merchantId: id.toString(), pricePerCallZc: env("PRICE_ZC", "0.5"), pay: "x402, scheme zipnet" }));
      }
      if (url.pathname === "/entry") {
        if (!(await charge(req, res))) return;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ entry: ENTRIES[Math.floor(Math.random() * ENTRIES.length)] }));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message.split("\n")[0] }));
    }
  })
  .listen(port, () => console.log(`[archive] merchant ${id} on :${port}, ${env("PRICE_ZC", "0.5")} ZC per entry`));
