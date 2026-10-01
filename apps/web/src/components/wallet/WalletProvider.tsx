"use client";

import { badgeLockIdentity, masterKeys, mnemonicFromSignature, isMnemonic, proverIn, scanBadgeLockIdentities, zipAddressKeys, zipBadgesAbi, zipIdentities, ZIP_MESSAGE, type MasterKeys } from "@zipnet/sdk";
import type { Identity } from "@semaphore-protocol/core";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, http, type Address, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { legacyInjected, pageDiscovery, type Eip1193, type InjectedWallet } from "@/lib/eip6963";
import { releaseFailedSpends } from "@/lib/pending-spends";
import { forgetSession, isMobile, optionId, readChoice, rememberChoice, walletConnectOffered } from "@/lib/wallet-choice";
import { erc20, loadConfig, loadPool, myNotes, publicClient, type Config, type Pool } from "@/lib/wallet";

/**
 * An unlocked zip key. Its Semaphore identities are per purpose (SDK `zipIdentities`, M-11), and per lock for badges:
 * - Each new badge lock gets its own identity, `badgeLockIdentity(keys, index)` with the lock's index (A-7), so a key
 *   can hold several live locks and they aren't linked. `nextLockIdentity` is the one for the next lock.
 * - `identities.badges` holds every badge identity this key has locked with (per-lock ones found on chain, the one
 *   v2 badge identity and the v1 identity), for unlock and payout recovery (`lockIdentity`).
 * - `proverFor(members)` picks the identity to prove with in a group: the first live lock's identity that is a member,
 *   highest tier first (A-8), so a live v1 lock never shadows a higher-tier v2 one. `identity` is the highest live
 *   tier's identity, for callers that don't have a group at hand.
 * Nothing about them is stored: they are recomputed from the key, and the locks found on chain pick the active ones.
 */
type ZipKey = { keys: MasterKeys; privateKey: Uint8Array; publicKey: `0x${string}`; phrase: string; identities: ReturnType<typeof zipIdentities> };
type Zip = ZipKey & { identity: Identity; provers: Identity[]; proverFor: (members: bigint[]) => Identity | null; nextLockIdentity: Identity };

/** A badge lock made by one of this zip key's badge identities (ZipBadges.Locked). */
export type MyLock = { lockId: bigint; tier: number; value: bigint; unlockAt: number; unlocked: boolean; identityCommitment: bigint };

/** The identity that made `lock`, to prove with for it (unlock, payout recovery). */
export const lockIdentity = (zip: Zip, lock: Pick<MyLock, "identityCommitment">) =>
  zip.identities.badges.find((i) => i.commitment === lock.identityCommitment) ?? zip.identity;

type Ctx = {
  config: Config | null;
  configError: string | null;
  pub: PublicClient | null;
  wallet: WalletClient | null;
  address: Address | null;
  kind: "injected" | "walletconnect" | "dev" | null;
  /** The connected wallet's name (from its EIP-6963 announcement or WalletConnect session), when known */
  walletName: string | null;
  /** Whether "Mobile wallet (WalletConnect)" is offered here: a Reown project ID is set and this page allows it */
  walletConnectEnabled: boolean;
  zip: Zip | null;
  pool: Pool | null;
  notes: ReturnType<typeof myNotes> | null;
  locks: MyLock[];
  walletZc: bigint;
  refreshing: boolean;
  /** The remembered browser wallet, else the first one announced (EIP-6963), else window.ethereum */
  connectInjected: () => Promise<void>;
  /** A browser wallet from the picker (EIP-6963) */
  connectAnnounced: (w: InjectedWallet) => Promise<void>;
  /** Pairs a phone wallet; `onUri` gets the pairing link and its QR code to show. Loads the WalletConnect SDK on first use. */
  connectWalletConnect: (onUri: (p: WcPairing) => void, signal?: AbortSignal) => Promise<void>;
  /** Connects any EIP-1193 provider. */
  connectWith: (eth: Eip1193) => Promise<void>;
  connectDev: () => Promise<void>;
  /** Forgets the connection (ends a WalletConnect session) and locks the zip key */
  disconnect: () => Promise<void>;
  unlock: () => Promise<void>;
  unlockWithPhrase: (phrase: string) => void;
  refresh: () => Promise<void>;
};

export type { Eip1193 };
export type WcPairing = { uri: string; qr: boolean[][]; links: { name: string; href: string }[]; mobile: boolean };
type WcModule = typeof import("@/lib/walletconnect");
type WcConnection = Awaited<ReturnType<WcModule["connect"]>>;
type WalletChange = { kind: "disconnect" } | { kind: "account"; account: string };

const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const onPhone = () => typeof navigator !== "undefined" && isMobile(navigator.userAgent, navigator.maxTouchPoints);

const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
};

const DEV_KEY = "zipnet.devKey";

/** Gas and 1,000 ZC for a dev wallet, from the local-only faucet. */
async function faucet(address: Address) {
  const res = await fetch("/api/dev/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  if (!res.ok) throw new Error((await res.json()).error);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [kind, setKind] = useState<Ctx["kind"]>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const pathname = usePathname() ?? "/";
  const walletConnectEnabled = walletConnectOffered(config, pathname);
  const wcRef = useRef<WcConnection | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const devOffRef = useRef(false);
  const [zipKey, setZip] = useState<ZipKey | null>(null);
  const [pool, setPool] = useState<Pool | null>(null);
  const poolRef = useRef<Pool | null>(null);
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
      // Warm sync: only what changed since the state we last verified
      const next = await loadPool(config, pub, poolRef.current?.state);
      // Notes whose courier job failed were never spent: offer them again (see lib/pending-spends)
      await releaseFailedSpends();
      poolRef.current = next;
      setPool(next);
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

  const clearWallet = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    wcRef.current = null;
    setWallet(null);
    setKind(null);
    setWalletName(null);
    setZip(null);
  }, []);

  /** Uses `account` of `eth` as the wallet, and follows the wallet's account switches and disconnects. */
  const attach = useCallback(
    (eth: Eip1193, account: string, k: "injected" | "walletconnect", name: string | null, watch?: (fn: (e: WalletChange) => void) => () => void) => {
      unsubRef.current?.();
      unsubRef.current = null;
      setWallet(createWalletClient({ account: account as Address, transport: custom(eth) }));
      setKind(k);
      setWalletName(name);
      setZip(null);
      const onChange = (e: WalletChange) => {
        if (e.kind === "disconnect") return clearWallet();
        // Another account means another zip key: lock it until the new account signs
        setWallet(createWalletClient({ account: e.account as Address, transport: custom(eth) }));
        setZip(null);
      };
      if (watch) unsubRef.current = watch(onChange);
      else if (eth.on && eth.removeListener) {
        const onAccounts = (accs: string[]) => onChange(accs?.[0] ? { kind: "account", account: accs[0] } : { kind: "disconnect" });
        eth.on("accountsChanged", onAccounts as never);
        unsubRef.current = () => eth.removeListener!("accountsChanged", onAccounts as never);
      }
    },
    [clearWallet],
  );

  const connectWith = useCallback(
    async (eth: Eip1193, name: string | null = null) => {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!account) throw new Error("The wallet didn't share an account.");
      attach(eth, account, "injected", name);
    },
    [attach],
  );

  const connectAnnounced = useCallback(
    async (w: InjectedWallet) => {
      await connectWith(w.provider, w.info.name);
      rememberChoice(store(), optionId(w));
    },
    [connectWith],
  );

  const connectInjected = useCallback(async () => {
    const found = pageDiscovery()?.list() ?? [];
    const last = readChoice(store());
    const pick = found.find((w) => optionId(w) === last?.id) ?? found[0];
    if (pick) return connectAnnounced(pick);
    const eth = legacyInjected(window);
    if (!eth) throw new Error("No browser wallet found. Install one, or use the dev wallet on a local chain.");
    await connectWith(eth);
    rememberChoice(store(), "injected");
  }, [connectAnnounced, connectWith]);

  const connectWalletConnect = useCallback(
    async (onUri: (p: WcPairing) => void, signal?: AbortSignal) => {
      const cfg = config?.walletConnect;
      if (!cfg || !walletConnectEnabled) throw new Error("Mobile wallets aren't set up on this server.");
      // The SDK and the QR encoder are a separate chunk, fetched from our own origin only now
      const wc: WcModule = await import("@/lib/walletconnect");
      const mobile = onPhone();
      const conn = await wc.connect(cfg, (uri) => onUri({ uri, qr: wc.qrMatrix(uri), links: wc.mobileLinks(uri), mobile }), mobile);
      if (signal?.aborted) {
        await conn.disconnect();
        throw new Error("Cancelled.");
      }
      wcRef.current = conn;
      attach(conn.provider, conn.account, "walletconnect", conn.peerName, conn.onChange);
      rememberChoice(store(), "walletconnect");
    },
    [config, walletConnectEnabled, attach],
  );

  const disconnect = useCallback(async () => {
    const wc = wcRef.current;
    if (kind === "dev") devOffRef.current = true;
    forgetSession(store());
    clearWallet();
    await wc?.disconnect();
  }, [kind, clearWallet]);

  const connectDev = useCallback(async () => {
    if (!config?.devWallet) throw new Error("The dev wallet only exists on local deployments.");
    let key = sessionStorage.getItem(DEV_KEY) as `0x${string}` | null;
    if (!key) {
      key = generatePrivateKey();
      sessionStorage.setItem(DEV_KEY, key);
      await faucet(privateKeyToAccount(key).address);
    }
    unsubRef.current?.();
    unsubRef.current = null;
    devOffRef.current = false;
    setWallet(createWalletClient({ account: privateKeyToAccount(key), transport: http(config.rpcUrl) }));
    setKind("dev");
    setWalletName(null);
    setZip(null);
  }, [config]);

  const fromPhrase = (phrase: string): ZipKey => {
    const keys = masterKeys(phrase);
    const z = zipAddressKeys(keys.masterSecret);
    return { keys, privateKey: z.privateKey, publicKey: z.publicKey, phrase, identities: zipIdentities(keys) };
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
    if (!config?.devWallet || wallet || devOffRef.current || !sessionStorage.getItem(DEV_KEY)) return;
    const account = privateKeyToAccount(sessionStorage.getItem(DEV_KEY) as `0x${string}`);
    const w = createWalletClient({ account, transport: http(config.rpcUrl) });
    setWallet(w);
    setKind("dev");
    w.signMessage({ account, message: ZIP_MESSAGE }).then((sig) => setZip(fromPhrase(mnemonicFromSignature(sig))));
    // A restarted local chain forgets the dev wallet's funds while the tab keeps its key: fund it again
    pub
      ?.getBalance({ address: account.address })
      .then((b) => (b === 0n ? faucet(account.address).then(refresh) : undefined))
      .catch((e) => console.warn("[wallet] dev faucet failed:", e));
  }, [config, wallet, pub, refresh]);

  // Restore the connection from the last visit, silently: eth_accounts from the remembered browser wallet (no prompt;
  // empty unless the site is still authorized), or the WalletConnect session if the wallet kept it. Never a
  // signature: the zip key still waits for "Unlock".
  const restored = useRef(false);
  useEffect(() => {
    if (!config || restored.current || wallet) return;
    restored.current = true;
    if (config.devWallet && sessionStorage.getItem(DEV_KEY)) return;
    const last = readChoice(store());
    if (!last?.reconnect) return;
    let live = true;
    const silent = async (eth: Eip1193, name: string | null) => {
      const accounts = (await eth.request({ method: "eth_accounts" }).catch(() => [])) as string[] | null;
      if (live && accounts?.[0]) attach(eth, accounts[0], "injected", name);
    };
    let cleanup = () => {};
    if (last.id === "walletconnect") {
      const cfg = config.walletConnect;
      if (!walletConnectEnabled || !cfg) return;
      import("@/lib/walletconnect")
        .then((wc) => wc.restore(cfg, onPhone()))
        .then((conn) => {
          if (!live || !conn) return;
          wcRef.current = conn;
          attach(conn.provider, conn.account, "walletconnect", conn.peerName, conn.onChange);
        })
        .catch((e) => console.warn("[wallet] WalletConnect restore failed:", e));
    } else if (last.id === "injected") {
      const eth = legacyInjected(window);
      if (eth) silent(eth, null);
    } else if (last.id.startsWith("6963:")) {
      // Wallets usually announce at once; give slow ones a moment
      const d = pageDiscovery();
      const tryNow = () => {
        const w = d?.list().find((x) => optionId(x) === last.id);
        if (!w) return false;
        silent(w.provider, w.info.name);
        return true;
      };
      if (!tryNow() && d) {
        const off = d.subscribe(() => void (tryNow() && off()));
        const t = setTimeout(off, 1500);
        cleanup = () => {
          off();
          clearTimeout(t);
        };
      }
    }
    return () => {
      live = false;
      cleanup();
    };
  }, [config, wallet, pathname, walletConnectEnabled, attach]);

  // This key's badge locks (per-lock identities, the one v2 badge identity and the v1 identity), from events
  // (identityCommitment isn't indexed, so filter client-side). The count also numbers badge-return notes and per-lock
  // identities, so it spans every identity.
  const [locks, setLocks] = useState<MyLock[]>([]);
  const [lockIds, setLockIds] = useState<Identity[]>([]);
  useEffect(() => {
    if (!config || !pub || !zipKey) {
      setLockIds([]);
      return setLocks([]);
    }
    const from = BigInt(config.deployment.deployBlock);
    const lockedEv = zipBadgesAbi.find((x) => x.type === "event" && x.name === "Locked")!;
    const unlockedEv = zipBadgesAbi.find((x) => x.type === "event" && x.name === "Unlocked")!;
    Promise.all([
      pub.getLogs({ address: config.deployment.badges, event: lockedEv as never, fromBlock: from }),
      pub.getLogs({ address: config.deployment.badges, event: unlockedEv as never, fromBlock: from }),
    ]).then(([l, u]) => {
      const done = new Set((u as { args: { lockId: bigint } }[]).map((x) => x.args.lockId));
      const all = l as { args: { lockId: bigint; tier: number; identityCommitment: bigint; value: bigint; unlockAt: bigint } }[];
      const seen = new Set(all.map((x) => x.args.identityCommitment));
      const older = new Set(zipKey.identities.badges.map((i) => i.commitment));
      const perLock = scanBadgeLockIdentities(zipKey.keys, (c) => seen.has(c), all.filter((x) => older.has(x.args.identityCommitment)).length).map(([, id]) => id);
      const mineIds = new Set([...older, ...perLock.map((i) => i.commitment)]);
      setLockIds(perLock);
      const mine = all
        .filter((x) => mineIds.has(x.args.identityCommitment))
        .map((x) => ({
          lockId: x.args.lockId,
          tier: Number(x.args.tier),
          value: x.args.value,
          unlockAt: Number(x.args.unlockAt),
          unlocked: done.has(x.args.lockId),
          identityCommitment: x.args.identityCommitment,
        }));
      setLocks(mine);
    });
  }, [config, pub, zipKey, pool]);

  // Prove per group with a live lock's identity, highest tier first (A-8); fall back to any badge identity
  const zip = useMemo<Zip | null>(() => {
    if (!zipKey) return null;
    const badges = [...lockIds, ...zipKey.identities.badges];
    const byCommitment = new Map(badges.map((i) => [i.commitment, i] as const));
    const live = [...locks].filter((l) => !l.unlocked).sort((a, b) => b.tier - a.tier);
    const provers = [...new Set([...live.map((l) => byCommitment.get(l.identityCommitment)).filter((i): i is Identity => !!i), ...badges])];
    return {
      ...zipKey,
      identities: { ...zipKey.identities, badges },
      identity: provers[0],
      provers,
      proverFor: (members: bigint[]) => proverIn(provers, members),
      nextLockIdentity: badgeLockIdentity(zipKey.keys, BigInt(locks.length)),
    };
  }, [zipKey, locks, lockIds]);

  const notes = useMemo(() => (config && zip && pool ? myNotes(config, zip.keys, zip.privateKey, pool, locks.length) : null), [config, zip, pool, locks.length]);

  const value: Ctx = {
    config,
    configError,
    pub,
    wallet,
    address,
    kind,
    walletName,
    walletConnectEnabled,
    zip,
    pool,
    notes,
    locks,
    walletZc,
    refreshing,
    connectInjected,
    connectAnnounced,
    connectWalletConnect,
    connectWith,
    connectDev,
    disconnect,
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
