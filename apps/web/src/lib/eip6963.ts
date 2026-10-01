// EIP-6963 multi-injected provider discovery (https://eips.ethereum.org/EIPS/eip-6963). Each browser wallet announces
// itself with an `eip6963:announceProvider` event carrying its name, icon, reverse-DNS id and EIP-1193 provider; we ask
// with `eip6963:requestProvider`. Wallets that predate the standard only set `window.ethereum`, which stays the
// fallback when nothing announces. Pure DOM events, no dependencies, so it runs in tests with a plain EventTarget.

export type Eip1193 = {
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, listener: (...args: never[]) => void) => void;
  removeListener?: (event: string, listener: (...args: never[]) => void) => void;
};

export type WalletInfo = { uuid: string; name: string; icon: string | null; rdns: string };
export type InjectedWallet = { info: WalletInfo; provider: Eip1193 };

/** Only raster or SVG images as data: URIs. Anything else (http URLs, javascript:, other data types) is dropped. */
const ICON = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)(;[a-z0-9=.+-]+)*(;base64)?,/i;
const MAX_ICON = 256 * 1024;

/** The icon if it's a data:image/* URI of sane size, else null (the picker shows a letter instead). */
export function safeIcon(icon: unknown): string | null {
  return typeof icon === "string" && icon.length <= MAX_ICON && ICON.test(icon) ? icon : null;
}

/** Reverse DNS like io.metamask or com.coinbase.wallet */
const RDNS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** An announcement's detail, checked and cleaned, or null if it isn't a usable wallet. */
export function parseAnnouncement(detail: unknown): InjectedWallet | null {
  if (!detail || typeof detail !== "object") return null;
  const { info, provider } = detail as { info?: Record<string, unknown>; provider?: Eip1193 };
  if (!info || !provider || typeof provider.request !== "function") return null;
  const name = typeof info.name === "string" ? info.name.replace(/\s+/g, " ").trim().slice(0, 48) : "";
  const rdns = typeof info.rdns === "string" ? info.rdns.trim().toLowerCase() : "";
  const uuid = typeof info.uuid === "string" ? info.uuid : "";
  if (!name || !uuid || !RDNS.test(rdns) || rdns.length > 128) return null;
  return { info: { uuid, name, rdns, icon: safeIcon(info.icon) }, provider };
}

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;

export type Discovery = {
  /** The wallets announced so far, one per rdns (a re-announcement replaces the earlier one), in announcement order */
  list: () => InjectedWallet[];
  /** Called on every change; returns an unsubscribe */
  subscribe: (fn: () => void) => () => void;
  /** Asks the wallets to announce (again) */
  request: () => void;
  stop: () => void;
};

/** Starts listening for announcements on `target` (the window) and asks for them once. */
export function discoverWallets(target: Target): Discovery {
  const byRdns = new Map<string, InjectedWallet>();
  let snapshot: InjectedWallet[] = [];
  const subs = new Set<() => void>();
  const onAnnounce = (e: Event) => {
    const w = parseAnnouncement((e as CustomEvent).detail);
    if (!w) return;
    const prev = byRdns.get(w.info.rdns);
    if (prev && prev.provider === w.provider && prev.info.uuid === w.info.uuid) return;
    byRdns.set(w.info.rdns, w);
    snapshot = [...byRdns.values()];
    for (const f of subs) f();
  };
  const request = () => target.dispatchEvent(new Event("eip6963:requestProvider"));
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  request();
  return {
    list: () => snapshot,
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    request,
    stop: () => {
      target.removeEventListener("eip6963:announceProvider", onAnnounce);
      subs.clear();
    },
  };
}

/** The pre-6963 injected provider, if any */
export function legacyInjected(win: unknown): Eip1193 | null {
  const eth = (win as { ethereum?: Eip1193 } | undefined)?.ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

let shared: Discovery | null = null;
/** One discovery for the page: wallets announce once per request, and every picker should see the same list. */
export function pageDiscovery(): Discovery | null {
  if (typeof window === "undefined") return null;
  return (shared ??= discoverWallets(window));
}
