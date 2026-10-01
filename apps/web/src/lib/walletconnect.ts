// WalletConnect v2 (Reown) for mobile wallets. LOADED LAZILY: only `import("@/lib/walletconnect")` after a visitor picks
// "Mobile wallet (WalletConnect)" (or when restoring a session they made before), never a static import, so the base
// bundle and a first visit make no request to Reown.
//
// Why @walletconnect/universal-provider rather than @walletconnect/ethereum-provider or AppKit: ethereum-provider 2.25
// hard-depends on @reown/appkit (its QR modal, which loads fonts, wallet images and the wallet list from Reown's
// servers), and AppKit is the full UI framework. The universal provider is the layer both are built on: the Sign
// client, the relay and an EIP-1193 `request` per chain, with no UI. We render the pairing URI as a QR code ourselves
// (uqr, MIT, no dependencies, runs locally) and use `wc:` / the wallet's own links on phones.
//
// Privacy: telemetry is off (no pulse.walletconnect.org events), every chain uses our public RPC (no
// rpc.walletconnect.org), no analytics, onramp, swaps, email or social login exist at this layer. The relay sees
// encrypted messages between this page and the wallet, and the wallet's IP; never a zip secret or proof.

import { UniversalProvider } from "@walletconnect/universal-provider";
import { encode } from "uqr";

import type { Eip1193 } from "./eip6963";
import type { WalletConnectConfig } from "./wallet";

type UP = Awaited<ReturnType<typeof UniversalProvider.init>>;

/** What the wallet is asked to allow: signing the zip-key message, sending transactions, typed data for later use. */
export const WC_METHODS = ["personal_sign", "eth_sendTransaction", "eth_signTypedData_v4"];
export const WC_EVENTS = ["accountsChanged", "chainChanged"];
const NEEDS_WALLET = new Set(["personal_sign", "eth_sendTransaction", "eth_signTypedData_v4", "eth_requestAccounts"]);

export type WcConnection = {
  provider: Eip1193;
  account: string;
  chainId: number;
  /** The wallet's name as it reports it (shown as text only; its icon URL is never loaded) */
  peerName: string;
  disconnect: () => Promise<void>;
  /** Called when the wallet ends the session or switches account */
  onChange: (fn: (e: { kind: "disconnect" } | { kind: "account"; account: string }) => void) => () => void;
};

/** The namespace we propose: our chains only, each with our own RPC. */
export function proposal(cfg: WalletConnectConfig) {
  const chains = cfg.chains.map((c) => `eip155:${c.id}`);
  // The provider looks RPC URLs up both by "eip155:1" and by "1", so give both
  const rpcMap: Record<string, string> = {};
  for (const c of cfg.chains) rpcMap[`eip155:${c.id}`] = rpcMap[String(c.id)] = c.rpcUrl;
  return { optionalNamespaces: { eip155: { chains, methods: WC_METHODS, events: WC_EVENTS, rpcMap } } };
}

/** Provider options: telemetry off, our own storage prefix, and page metadata so wallets can check the domain. */
export function providerOptions(cfg: WalletConnectConfig, origin: string) {
  return {
    projectId: cfg.projectId,
    telemetryEnabled: false,
    logger: "error",
    customStoragePrefix: "zipnet",
    metadata: { name: "Veridia", description: "The zipcoin wallet", url: origin, icons: [`${origin}/icon.svg`] },
  };
}

/** A wallet-supplied link we may navigate to: https, or a wallet's own app scheme. Never javascript:, data:, etc. */
export function safeWalletLink(link: unknown): string | null {
  if (typeof link !== "string" || link.length > 512) return null;
  try {
    const u = new URL(link);
    const scheme = u.protocol.slice(0, -1).toLowerCase();
    if (scheme === "https") return u.href;
    if (["http", "javascript", "data", "blob", "file", "vbscript", "about", "filesystem", "ws", "wss", "ftp", "chrome", "intent"].includes(scheme)) return null;
    return /^[a-z][a-z0-9+.-]{1,31}$/.test(scheme) ? link : null;
  } catch {
    return null;
  }
}

/**
 * Links that open a phone wallet with the pairing URI. `wc:` is handled by any installed wallet that registered it;
 * the others are the wallets' documented universal links, for browsers that don't pass `wc:` on.
 */
export function mobileLinks(uri: string): { name: string; href: string }[] {
  const e = encodeURIComponent(uri);
  return [
    { name: "Open a wallet app", href: uri },
    { name: "MetaMask", href: `https://metamask.app.link/wc?uri=${e}` },
    { name: "Rainbow", href: `https://rnbwapp.com/wc?uri=${e}` },
    { name: "Trust", href: `https://link.trustwallet.com/wc?uri=${e}` },
  ];
}

/** The QR code for a pairing URI, as rows of dark (true) / light modules, drawn by the page (no image service). */
export const qrMatrix = (uri: string): boolean[][] => encode(uri, { ecc: "M", border: 0 }).data;

let shared: Promise<UP> | null = null;
function init(cfg: WalletConnectConfig): Promise<UP> {
  shared ??= UniversalProvider.init(providerOptions(cfg, window.location.origin) as Parameters<typeof UniversalProvider.init>[0]).catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

const accountFor = (session: UP["session"], chainId: number) =>
  session?.namespaces.eip155?.accounts.find((a) => a.startsWith(`eip155:${chainId}:`))?.split(":")[2] ?? null;

function wrap(up: UP, chainId: number, mobile: boolean): WcConnection {
  const chain = `eip155:${chainId}`;
  up.setDefaultChain(chain);
  const account = accountFor(up.session, chainId)!;
  // The wallet's own app scheme switches apps without leaving this page; an https link opens in a new tab so this
  // page (and the pending request) stays put if the app isn't installed
  const openWallet = () => {
    const r = up.session?.peer.metadata.redirect;
    const native = safeWalletLink(r?.native);
    if (native && !native.startsWith("https:")) return void (window.location.href = native);
    const universal = safeWalletLink(r?.universal);
    if (universal) window.open(universal, "_blank", "noopener,noreferrer");
  };
  return {
    account,
    chainId,
    peerName: (up.session?.peer.metadata.name ?? "Wallet").slice(0, 48),
    provider: {
      request: (a) => {
        const p = up.request({ method: a.method, params: a.params as unknown[] }, chain);
        // On a phone the request waits in the wallet app: switch to it
        if (mobile && NEEDS_WALLET.has(a.method)) setTimeout(openWallet, 50);
        return p;
      },
    },
    disconnect: async () => {
      try {
        if (up.session) await up.disconnect();
      } catch (e) {
        console.warn("[walletconnect] disconnect:", e);
      }
    },
    onChange: (fn) => {
      const onDel = () => fn({ kind: "disconnect" });
      const onAcc = (accs: string[]) => (accs[0] ? fn({ kind: "account", account: accs[0] }) : fn({ kind: "disconnect" }));
      up.on("session_delete", onDel);
      up.on("accountsChanged", onAcc);
      return () => {
        up.removeListener("session_delete", onDel);
        up.removeListener("accountsChanged", onAcc);
      };
    },
  };
}

/**
 * Pairs with a wallet. `onUri` gets the pairing URI to show as a QR code (or open on a phone). Resolves once the wallet
 * approves; rejects if it refuses, the proposal expires, or the wallet doesn't approve our chain.
 */
export async function connect(cfg: WalletConnectConfig, onUri: (uri: string) => void, mobile: boolean): Promise<WcConnection> {
  const up = await init(cfg);
  if (up.session) await up.disconnect().catch(() => undefined);
  const listener = (uri: string) => onUri(uri);
  up.on("display_uri", listener);
  try {
    await up.connect(proposal(cfg));
  } finally {
    up.removeListener("display_uri", listener);
  }
  const chainId = cfg.chains.find((c) => accountFor(up.session, c.id))?.id;
  if (!chainId) {
    await up.disconnect().catch(() => undefined);
    throw new Error(`Your wallet didn't approve chain ${cfg.chains.map((c) => c.id).join(" or ")}. Switch networks in the wallet and try again.`);
  }
  return wrap(up, chainId, mobile);
}

/** The session from an earlier visit, if the wallet still has it open; null otherwise. Never prompts. */
export async function restore(cfg: WalletConnectConfig, mobile: boolean): Promise<WcConnection | null> {
  const up = await init(cfg);
  if (!up.session) return null;
  const chainId = cfg.chains.find((c) => accountFor(up.session, c.id))?.id;
  return chainId ? wrap(up, chainId, mobile) : null;
}
