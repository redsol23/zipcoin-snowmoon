"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { legacyInjected, pageDiscovery, type InjectedWallet } from "@/lib/eip6963";
import { pickerOptions, readChoice, WALLETCONNECT_PRIVACY, type WalletOption } from "@/lib/wallet-choice";

import { errorText } from "./ui";
import { useWallet, type WcPairing } from "./WalletProvider";

const NONE: InjectedWallet[] = [];

/** Browser wallets announced on this page (EIP-6963), live. */
export function useInjectedWallets(): InjectedWallet[] {
  return useSyncExternalStore(
    (fn) => pageDiscovery()?.subscribe(fn) ?? (() => {}),
    () => pageDiscovery()?.list() ?? NONE,
    () => NONE,
  );
}

function Mark({ option }: { option: WalletOption }) {
  // Icons are data:image/* URIs only (lib/eip6963 drops anything else), so this never fetches from anywhere
  if (option.icon) return <img src={option.icon} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md object-contain" />;
  const glyph = option.kind === "walletconnect" ? "▯" : option.kind === "dev" ? "⚙" : option.name.slice(0, 1).toUpperCase();
  return (
    <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-drift text-sm font-medium text-pine">
      {glyph}
    </span>
  );
}

/** A QR code drawn as one SVG path from the module matrix (no image service, no canvas). */
function Qr({ matrix, label }: { matrix: boolean[][]; label: string }) {
  const d = useMemo(() => {
    let p = "";
    matrix.forEach((row, y) => row.forEach((on, x) => on && (p += `M${x} ${y}h1v1h-1z`)));
    return p;
  }, [matrix]);
  const n = matrix.length;
  const q = 4; // quiet zone
  return (
    <svg role="img" aria-label={label} viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`} shapeRendering="crispEdges" className="h-56 w-56 rounded-md bg-white">
      <path d={d} fill="#18241F" />
    </svg>
  );
}

function Pairing({ p, onCancel }: { p: WcPairing; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-frost bg-white/60 p-4">
      {p.mobile ? (
        <>
          <p className="text-sm">Open your wallet app to approve the connection.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {p.links.map((l) =>
              l.href.startsWith("https:") ? (
                <a key={l.name} href={l.href} target="_blank" rel="noopener noreferrer" className="rounded-md border border-frost px-3 py-2 text-sm hover:border-pine">
                  {l.name}
                </a>
              ) : (
                <a key={l.name} href={l.href} className="rounded-md bg-pine px-3 py-2 text-sm font-medium text-snow hover:bg-pine/90">
                  {l.name}
                </a>
              ),
            )}
          </div>
          <details className="mt-3 text-sm text-lichen">
            <summary className="cursor-pointer">Show a QR code for another device</summary>
            <div className="mt-2">
              <Qr matrix={p.qr} label="WalletConnect pairing code" />
            </div>
          </details>
        </>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <Qr matrix={p.qr} label="WalletConnect pairing code" />
          <div className="max-w-xs space-y-2 text-sm">
            <p>Scan this with your phone wallet (MetaMask, Rainbow, Trust and most others), then approve the connection there.</p>
            <button
              className="underline underline-offset-2 hover:text-pad"
              onClick={() =>
                navigator.clipboard?.writeText(p.uri).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy the connection link"}
            </button>
          </div>
        </div>
      )}
      <button className="mt-3 text-sm text-lichen underline underline-offset-2 hover:text-pine" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The wallet picker: every browser wallet that announces itself (EIP-6963), `window.ethereum` when none do, a phone
 * wallet over WalletConnect when the server has a Reown project ID, and the dev wallet on local chains. The last
 * choice comes first. WalletConnect's code is only fetched when it's picked.
 */
export function ConnectPicker({ className, onError, onConnected }: { className?: string; onError?: (message: string) => void; onConnected?: () => void }) {
  const w = useWallet();
  const discovered = useInjectedWallets();
  const [legacy, setLegacy] = useState(false);
  const [last, setLast] = useState<ReturnType<typeof readChoice>>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<WcPairing | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setLegacy(!!legacyInjected(window));
    try {
      setLast(readChoice(window.localStorage));
    } catch {
      setLast(null);
    }
    // Wallets injected after the page loaded answer a fresh request
    pageDiscovery()?.request();
  }, []);

  const options = pickerOptions({ discovered, legacy, walletConnect: w.walletConnectEnabled, devWallet: !!w.config?.devWallet, last });

  const fail = (e: unknown) => {
    const m = errorText(e);
    setErr(m);
    onError?.(m);
  };

  const pick = (o: WalletOption) => async () => {
    setBusy(o.id);
    setErr(null);
    abort.current?.abort();
    const ac = (abort.current = new AbortController());
    try {
      if (o.kind === "eip6963") await w.connectAnnounced(o.wallet);
      else if (o.kind === "injected") await w.connectInjected();
      else if (o.kind === "dev") await w.connectDev();
      else await w.connectWalletConnect((p) => void (!ac.signal.aborted && setPairing(p)), ac.signal);
      onConnected?.();
    } catch (e) {
      if (!ac.signal.aborted) fail(e);
    } finally {
      if (abort.current === ac) {
        setBusy(null);
        setPairing(null);
      }
    }
  };

  return (
    <div className={clsx("max-w-md", className)}>
      {options.length === 0 ? (
        <p className="rounded-md bg-drift px-3 py-2 text-sm">
          No browser wallet found. Install one (MetaMask, Rabby, Rainbow…) and reload this page{w.config?.devWallet ? ", or use the dev wallet" : ""}.
        </p>
      ) : (
        <ul className="divide-y divide-frost overflow-hidden rounded-md border border-frost bg-white/50">
          {options.map((o) => (
            <li key={o.id}>
              <button
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-drift disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!!busy}
                onClick={pick(o)}
              >
                <Mark option={o} />
                <span className="flex-1 font-medium text-pine">{o.name}</span>
                {busy === o.id ? <span className="text-lichen">Working…</span> : o.last && <span className="text-[0.75rem] text-lichen">Last used</span>}
              </button>
              {o.kind === "walletconnect" && <p className="px-3 pb-2.5 pl-[3.25rem] text-[0.8rem] leading-snug text-lichen">{WALLETCONNECT_PRIVACY}</p>}
            </li>
          ))}
        </ul>
      )}
      {pairing && busy === "walletconnect" && (
        <Pairing
          p={pairing}
          onCancel={() => {
            // The SDK can't withdraw a proposal (it expires on its own); a late approval is disconnected at once
            abort.current?.abort();
            abort.current = null;
            setPairing(null);
            setBusy(null);
          }}
        />
      )}
      {err && <p className="mt-2 text-sm text-pine">{err}</p>}
    </div>
  );
}
