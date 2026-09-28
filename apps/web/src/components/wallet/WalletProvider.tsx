"use client";

import { masterKeys, mnemonicFromSignature, isMnemonic, semaphoreIdentity, zipAddressKeys, zipBadgesAbi, ZIP_MESSAGE, type MasterKeys } from "@zipnet/sdk";
import type { Identity } from "@semaphore-protocol/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, http, type Address, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { erc20, loadConfig, loadPool, myNotes, publicClient, type Config, type Pool } from "@/lib/wallet";

type Zip = { keys: MasterKeys; privateKey: Uint8Array; publicKey: `0x${string}`; phrase: string; identity: Identity };

/** A badge lock made by this zip key's identity (ZipBadges.Locked). */
export type MyLock = { lockId: bigint; tier: number; value: bigint; unlockAt: number; unlocked: boolean };

type Ctx = {
  config: Config | null;
  configError: string | null;
  pub: PublicClient | null;
  wallet: WalletClient | null;
  address: Address | null;
  kind: "injected" | "dev" | null;
  zip: Zip | null;
  pool: Pool | null;
  notes: ReturnType<typeof myNotes> | null;
  locks: MyLock[];
  walletZc: bigint;
  refreshing: boolean;
  connectInjected: () => Promise<void>;
  connectDev: () => Promise<void>;
  unlock: () => Promise<void>;
  unlockWithPhrase: (phrase: string) => void;
  refresh: () => Promise<void>;
};

const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
};

const DEV_KEY = "zipnet.devKey";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [kind, setKind] = useState<Ctx["kind"]>(null);
  const [zip, setZip] = useState<Zip | null>(null);
  const [pool, setPool] = useState<Pool | null>(null);
  const [walletZc, setWalletZc] = useState(0n);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadConfig().then(setConfig, (e: Error) => setConfigError(e.message));
  }, []);
  const pub = useMemo(() => (config ? publicClient(config) : null), [config]);
  const address = wallet?.account?.address ?? null;

  const refresh = useCallback(async () => {
    if (!config || !pub) return;
    setRefreshing(true);
    try {
      setPool(await loadPool(config, pub));
      if (address) setWalletZc((await pub.readContract({ address: config.deployment.zc, abi: erc20, functionName: "balanceOf", args: [address] })) as bigint);
    } catch (e) {
      console.error("[wallet] refresh failed:", e);
    } finally {
      setRefreshing(false);
    }
  }, [config, pub, address]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const connectInjected = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<string[]> } }).ethereum;
    if (!eth) throw new Error("No browser wallet found. Install one, or use the dev wallet on a local chain.");
    const [account] = await eth.request({ method: "eth_requestAccounts" });
    setWallet(createWalletClient({ account: account as Address, transport: custom(eth) }));
    setKind("injected");
    setZip(null);
  }, []);

  const connectDev = useCallback(async () => {
    if (!config?.devWallet) throw new Error("The dev wallet only exists on local deployments.");
    let key = sessionStorage.getItem(DEV_KEY) as `0x${string}` | null;
    if (!key) {
      key = generatePrivateKey();
      sessionStorage.setItem(DEV_KEY, key);
      const account = privateKeyToAccount(key);
      const res = await fetch("/api/dev/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address }) });
      if (!res.ok) throw new Error((await res.json()).error);
    }
    setWallet(createWalletClient({ account: privateKeyToAccount(key), transport: http(config.rpcUrl) }));
    setKind("dev");
    setZip(null);
  }, [config]);

  const fromPhrase = (phrase: string): Zip => {
    const keys = masterKeys(phrase);
    const z = zipAddressKeys(keys.masterSecret);
    return { keys, privateKey: z.privateKey, publicKey: z.publicKey, phrase, identity: semaphoreIdentity(keys) };
  };

  const unlock = useCallback(async () => {
    if (!wallet?.account) throw new Error("Connect a wallet first.");
    const sig = await wallet.signMessage({ account: wallet.account, message: ZIP_MESSAGE });
    setZip(fromPhrase(mnemonicFromSignature(sig)));
  }, [wallet]);

  const unlockWithPhrase = useCallback((phrase: string) => {
    if (!isMnemonic(phrase)) throw new Error("That isn't a valid 12-word zip key.");
    setZip(fromPhrase(phrase));
  }, []);

  // A reload shouldn't lose the local dev wallet: its key is in sessionStorage and it signs silently, so reconnect
  // and unlock it again. Browser wallets are never auto-signed.
  useEffect(() => {
    if (!config?.devWallet || wallet || !sessionStorage.getItem(DEV_KEY)) return;
    const account = privateKeyToAccount(sessionStorage.getItem(DEV_KEY) as `0x${string}`);
    const w = createWalletClient({ account, transport: http(config.rpcUrl) });
    setWallet(w);
    setKind("dev");
    w.signMessage({ account, message: ZIP_MESSAGE }).then((sig) => setZip(fromPhrase(mnemonicFromSignature(sig))));
  }, [config, wallet]);

  // This identity's badge locks, from events (identityCommitment isn't indexed, so filter client-side)
  const [locks, setLocks] = useState<MyLock[]>([]);
  useEffect(() => {
    if (!config || !pub || !zip) return setLocks([]);
    const from = BigInt(config.deployment.deployBlock);
    const lockedEv = zipBadgesAbi.find((x) => x.type === "event" && x.name === "Locked")!;
    const unlockedEv = zipBadgesAbi.find((x) => x.type === "event" && x.name === "Unlocked")!;
    Promise.all([
      pub.getLogs({ address: config.deployment.badges, event: lockedEv as never, fromBlock: from }),
      pub.getLogs({ address: config.deployment.badges, event: unlockedEv as never, fromBlock: from }),
    ]).then(([l, u]) => {
      const done = new Set((u as { args: { lockId: bigint } }[]).map((x) => x.args.lockId));
      const mine = (l as { args: { lockId: bigint; tier: number; identityCommitment: bigint; value: bigint; unlockAt: bigint } }[])
        .filter((x) => x.args.identityCommitment === zip.identity.commitment)
        .map((x) => ({ lockId: x.args.lockId, tier: Number(x.args.tier), value: x.args.value, unlockAt: Number(x.args.unlockAt), unlocked: done.has(x.args.lockId) }));
      setLocks(mine);
    });
  }, [config, pub, zip, pool]);

  const notes = useMemo(() => (config && zip && pool ? myNotes(config, zip.keys, zip.privateKey, pool, locks.length) : null), [config, zip, pool, locks.length]);

  const value: Ctx = {
    config,
    configError,
    pub,
    wallet,
    address,
    kind,
    zip,
    pool,
    notes,
    locks,
    walletZc,
    refreshing,
    connectInjected,
    connectDev,
    unlock,
    unlockWithPhrase,
    refresh,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

/** Everything an action needs, or null until a wallet is connected and a zip key unlocked. */
export function useCtx(): import("@/lib/actions").Ctx | null {
  const w = useWallet();
  if (!w.config || !w.pub || !w.zip || !w.pool || !w.notes) return null;
  return { config: w.config, pub: w.pub, wallet: w.wallet, keys: w.zip.keys, pool: w.pool, notes: w.notes, walletZc: w.walletZc, refresh: w.refresh };
}
