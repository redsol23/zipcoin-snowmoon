import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../src/app/api/config/route";
import { configProblems, MISSING_PUBLIC_RPC, publicConfig } from "../src/lib/public-config";

const dep = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "local.json");
fs.writeFileSync(dep, JSON.stringify({ chainId: 31337 }));
const SERVER_RPC = "https://rpc.internal.example/v1/SECRET-KEY";

const KEYS = ["DEPLOYMENT", "PUBLIC_RPC_URL", "RPC_URL", "PUBLIC_COURIER_URL", "COURIER_URL", "DEV_FAUCET_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

describe("/api/config", () => {
  it("sends PUBLIC_RPC_URL, never RPC_URL", async () => {
    Object.assign(process.env, { DEPLOYMENT: dep, PUBLIC_RPC_URL: "https://public.example/rpc", RPC_URL: SERVER_RPC });
    const res = GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).rpcUrl).toBe("https://public.example/rpc");
    expect(text).not.toContain("SECRET-KEY");
  });

  it("without PUBLIC_RPC_URL: a configuration error, not the server's RPC_URL or a default", async () => {
    Object.assign(process.env, { DEPLOYMENT: dep, RPC_URL: SERVER_RPC });
    delete process.env.PUBLIC_RPC_URL;
    const res = GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("SECRET-KEY");
    expect(text).not.toContain("127.0.0.1");
    expect(JSON.parse(text)).toMatchObject({ error: MISSING_PUBLIC_RPC, code: "PUBLIC_RPC_URL_UNSET" });
    // blank counts as unset
    expect(publicConfig({ DEPLOYMENT: dep, PUBLIC_RPC_URL: "  ", RPC_URL: SERVER_RPC }).status).toBe(503);
  });

  it("the start-up check reports the missing PUBLIC_RPC_URL", () => {
    expect(configProblems({ DEPLOYMENT: dep, RPC_URL: SERVER_RPC })).toEqual([MISSING_PUBLIC_RPC]);
    expect(configProblems({ DEPLOYMENT: dep, PUBLIC_RPC_URL: "https://public.example/rpc" })).toEqual([]);
  });
});

describe("/api/config: WalletConnect", () => {
  const PID = "0123456789abcdef0123456789abcdef";
  it("null without a project ID, so the wallet hides the option", () => {
    const { body } = publicConfig({ DEPLOYMENT: dep, PUBLIC_RPC_URL: "https://public.example/rpc" });
    expect(body.walletConnect).toBeNull();
  });
  it("the project ID and the deployment's chain with the public RPC, never RPC_URL", () => {
    for (const key of ["WALLETCONNECT_PROJECT_ID", "NEXT_PUBLIC_REOWN_PROJECT_ID"]) {
      const { body } = publicConfig({ DEPLOYMENT: dep, PUBLIC_RPC_URL: "https://public.example/rpc", RPC_URL: SERVER_RPC, [key]: PID });
      expect(body.walletConnect).toEqual({ projectId: PID, chains: [{ id: 31337, rpcUrl: "https://public.example/rpc" }] });
      expect(JSON.stringify(body)).not.toContain("SECRET-KEY");
    }
  });
});
