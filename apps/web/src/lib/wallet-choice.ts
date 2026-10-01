// The wallet picker's state, kept free of React and the DOM so it can be tested: which options to offer, in what order,
// and the remembered last choice (localStorage). Only the choice's id is stored (an rdns like io.metamask, or
// "injected" / "walletconnect"), never an address.

import type { InjectedWallet } from "./eip6963";
import { walletConnectRoute } from "./security-headers";

export type OptionId = `6963:${string}` | "injected" | "walletconnect" | "dev";

export type WalletOption =
  | { id: `6963:${string}`; kind: "eip6963"; name: string; icon: string | null; wallet: InjectedWallet; last: boolean }
  | { id: "injected"; kind: "injected"; name: string; icon: null; last: boolean }
  | { id: "walletconnect"; kind: "walletconnect"; name: string; icon: null; last: boolean }
  | { id: "dev"; kind: "dev"; name: string; icon: null; last: boolean };

export type Choice = { id: OptionId; reconnect: boolean };

export const CHOICE_KEY = "zipnet.wallet.last";
export const WALLETCONNECT_LABEL = "Mobile wallet (WalletConnect)";
export const WALLETCONNECT_PRIVACY = "WalletConnect routes the connection through Reown's relay. Your zip secrets and proofs never leave this device.";

type Store = Pick<Storage, "getItem" | "setItem">;

const validId = (id: unknown): id is OptionId =>
  typeof id === "string" && (id === "injected" || id === "walletconnect" || id === "dev" || /^6963:[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id));

/** The remembered choice, or null. Never throws (private mode, blocked storage, junk in the key). */
export function readChoice(store: Store | null | undefined): Choice | null {
  try {
    const raw = store?.getItem(CHOICE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { id?: unknown; reconnect?: unknown };
    return validId(j.id) ? { id: j.id, reconnect: j.reconnect === true } : null;
  } catch {
    return null;
  }
}

/** Remembers a successful connection; `reconnect` says whether to restore it silently on the next visit. */
export function rememberChoice(store: Store | null | undefined, id: OptionId, reconnect = true) {
  try {
    store?.setItem(CHOICE_KEY, JSON.stringify({ id, reconnect }));
  } catch {
    /* storage unavailable: the picker just won't remember */
  }
}

/** After a disconnect: keep the wallet at the top of the list, but don't reconnect on the next visit. */
export function forgetSession(store: Store | null | undefined) {
  const c = readChoice(store);
  if (c) rememberChoice(store, c.id, false);
}

export const optionId = (w: InjectedWallet): `6963:${string}` => `6963:${w.info.rdns}`;

/**
 * What the picker shows: every announced wallet; the plain browser wallet only when nothing announced but
 * window.ethereum exists; WalletConnect when configured for this page; the dev wallet on local chains. The last choice
 * comes first and is marked.
 */
export function pickerOptions(o: { discovered: InjectedWallet[]; legacy: boolean; walletConnect: boolean; devWallet: boolean; last: Choice | null }): WalletOption[] {
  const out: WalletOption[] = o.discovered.map((w) => ({ id: optionId(w), kind: "eip6963" as const, name: w.info.name, icon: w.info.icon, wallet: w, last: false }));
  if (out.length === 0 && o.legacy) out.push({ id: "injected", kind: "injected", name: "Browser wallet", icon: null, last: false });
  if (o.walletConnect) out.push({ id: "walletconnect", kind: "walletconnect", name: WALLETCONNECT_LABEL, icon: null, last: false });
  if (o.devWallet) out.push({ id: "dev", kind: "dev", name: "Dev wallet (local chain)", icon: null, last: false });
  const i = o.last ? out.findIndex((x) => x.id === o.last!.id) : -1;
  if (i >= 0) {
    const [hit] = out.splice(i, 1);
    out.unshift({ ...hit, last: true } as WalletOption);
  }
  return out;
}

/** Whether to offer WalletConnect: /api/config carried a project ID and chains, and this page's CSP allows the relay. */
export function walletConnectOffered(config: { walletConnect?: { projectId: string; chains: unknown[] } | null } | null | undefined, pathname: string): boolean {
  return !!config?.walletConnect?.projectId && config.walletConnect.chains.length > 0 && walletConnectRoute(pathname);
}

/** Phones and tablets, where WalletConnect opens the wallet app instead of showing a QR code. */
export function isMobile(ua: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(ua)) return true;
  // iPadOS reports a desktop Safari user agent
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}
