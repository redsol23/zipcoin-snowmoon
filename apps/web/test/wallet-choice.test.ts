import { describe, expect, it, vi } from "vitest";

import type { InjectedWallet } from "../src/lib/eip6963";
import {
  CHOICE_KEY,
  forgetSession,
  isMobile,
  pickerOptions,
  readChoice,
  rememberChoice,
  walletConnectOffered,
  WALLETCONNECT_LABEL,
  WALLETCONNECT_PRIVACY,
} from "../src/lib/wallet-choice";

const wallet = (rdns: string, name: string): InjectedWallet => ({ info: { uuid: `u-${rdns}`, name, rdns, icon: null }, provider: { request: vi.fn() } });
const mm = wallet("io.metamask", "MetaMask");
const rabby = wallet("io.rabby", "Rabby Wallet");

class MemoryStore {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
}

describe("picker options", () => {
  const base = { discovered: [mm, rabby], legacy: true, walletConnect: false, devWallet: false, last: null };

  it("lists announced wallets; window.ethereum only when nothing announced", () => {
    expect(pickerOptions(base).map((o) => o.id)).toEqual(["6963:io.metamask", "6963:io.rabby"]);
    expect(pickerOptions({ ...base, discovered: [] }).map((o) => o.id)).toEqual(["injected"]);
    expect(pickerOptions({ ...base, discovered: [], legacy: false })).toEqual([]);
  });

  it("WalletConnect only when enabled, and the dev wallet only on local chains", () => {
    expect(pickerOptions(base).some((o) => o.kind === "walletconnect")).toBe(false);
    const all = pickerOptions({ ...base, walletConnect: true, devWallet: true });
    expect(all.map((o) => o.id)).toEqual(["6963:io.metamask", "6963:io.rabby", "walletconnect", "dev"]);
    expect(all.find((o) => o.kind === "walletconnect")?.name).toBe(WALLETCONNECT_LABEL);
  });

  it("the last choice comes first and is marked", () => {
    const o = pickerOptions({ ...base, walletConnect: true, last: { id: "6963:io.rabby", reconnect: false } });
    expect(o.map((x) => x.id)).toEqual(["6963:io.rabby", "6963:io.metamask", "walletconnect"]);
    expect(o.map((x) => x.last)).toEqual([true, false, false]);
    const wc = pickerOptions({ ...base, walletConnect: true, last: { id: "walletconnect", reconnect: true } });
    expect(wc[0]).toMatchObject({ id: "walletconnect", last: true });
    // A remembered wallet that isn't here any more changes nothing
    expect(pickerOptions({ ...base, last: { id: "6963:com.gone", reconnect: true } }).every((x) => !x.last)).toBe(true);
  });

  it("privacy note: Reown's relay, and secrets stay local", () => {
    expect(WALLETCONNECT_PRIVACY).toMatch(/^WalletConnect routes the connection through Reown's relay\./);
    expect(WALLETCONNECT_PRIVACY).toMatch(/Your zip secrets and proofs never leave this device\.$/);
  });
});

describe("remembered choice", () => {
  it("round-trips the id (an rdns, never an address) and the reconnect flag", () => {
    const s = new MemoryStore();
    expect(readChoice(s)).toBeNull();
    rememberChoice(s, "6963:io.metamask");
    expect(readChoice(s)).toEqual({ id: "6963:io.metamask", reconnect: true });
    expect(s.m.get(CHOICE_KEY)).not.toMatch(/0x/);
    forgetSession(s);
    expect(readChoice(s)).toEqual({ id: "6963:io.metamask", reconnect: false });
  });

  it("ignores junk and survives broken storage", () => {
    const s = new MemoryStore();
    s.setItem(CHOICE_KEY, "{not json");
    expect(readChoice(s)).toBeNull();
    s.setItem(CHOICE_KEY, JSON.stringify({ id: "javascript:alert(1)" }));
    expect(readChoice(s)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readChoice(broken)).toBeNull();
    expect(() => rememberChoice(broken, "walletconnect")).not.toThrow();
    expect(readChoice(null)).toBeNull();
  });
});

describe("WalletConnect offered", () => {
  const wc = { projectId: "0123456789abcdef0123456789abcdef", chains: [{ id: 1, rpcUrl: "https://rpc.example" }] };
  it("hidden without a project ID from /api/config", () => {
    expect(walletConnectOffered({ walletConnect: null }, "/wallet")).toBe(false);
    expect(walletConnectOffered({}, "/wallet")).toBe(false);
    expect(walletConnectOffered(null, "/wallet")).toBe(false);
    expect(walletConnectOffered({ walletConnect: { ...wc, chains: [] } }, "/wallet")).toBe(false);
  });
  it("shown with one, except on API routes", () => {
    expect(walletConnectOffered({ walletConnect: wc }, "/wallet")).toBe(true);
    expect(walletConnectOffered({ walletConnect: wc }, "/claim")).toBe(true);
    expect(walletConnectOffered({ walletConnect: wc }, "/api/config")).toBe(false);
  });
});

it("detects phones", () => {
  expect(isMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148")).toBe(true);
  expect(isMobile("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36")).toBe(true);
  expect(isMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5)).toBe(true); // iPadOS
  expect(isMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 0)).toBe(false);
  expect(isMobile("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0")).toBe(false);
});
