"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Address } from "viem";

import type { ParkedPayout } from "./payouts-parked";
import { recoverPayout, scanParkedPayouts, type Recovery } from "./parked-scan";
import { Button, errorText, Field, inputCls, Result, zc, type Outcome } from "./ui";
import { useWallet } from "./WalletProvider";

/**
 * Parked payouts: a badge stake whose trip back into the pool failed, waiting for its
 * owner to say where it goes (see ./payouts-parked). The wallet scans for them in the background, so the tab can show a dot;
 * every recovery goes through a courier.
 */

const RESCAN_MS = 60_000;

export type ParkedState = ReturnType<typeof useParkedPayouts>;

/** Scans for this key's parked payouts: when the pool view or locks change (at most once a minute), and on demand. */
export function useParkedPayouts() {
  const w = useWallet();
  const [items, setItems] = useState<ParkedPayout[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const running = useRef(false);

  const scan = useCallback(
    async (force = false) => {
      if (!w.config || !w.pub || !w.zip || !w.pool || running.current) return;
      if (!force && Date.now() - last.current < RESCAN_MS) return;
      running.current = true;
      last.current = Date.now();
      setScanning(true);
      try {
        setItems(
          await scanParkedPayouts({
            config: w.config,
            pub: w.pub,
            keys: w.zip.keys,
            zipAddressKey: w.zip.privateKey,
            pool: w.pool,
            locks: w.locks,
          }),
        );
        setError(null);
      } catch (e) {
        setError(errorText(e));
      } finally {
        running.current = false;
        setScanning(false);
      }
    },
    [w.config, w.pub, w.zip, w.pool, w.locks],
  );

  // A new key is worth a scan straight away (declared first: effects run in order)
  useEffect(() => {
    last.current = 0;
  }, [w.zip?.publicKey]);
  useEffect(() => {
    scan();
  }, [scan]);

  return { items, scanning, error, rescan: () => scan(true) };
}

/** A line above the tabs while something is parked, so it's noticed from any tab. */
export function ParkedNotice({ parked, onOpen }: { parked: ParkedState; onOpen: () => void }) {
  const n = parked.items.length;
  if (!n) return null;
  return (
    <button onClick={onOpen} className="mb-3 flex w-full items-center gap-2 rounded-md bg-candle/15 px-3 py-2 text-left text-sm text-pine hover:bg-candle/25">
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-candle" />
      {n === 1 ? "One of your payouts is parked and needs you to say where it goes." : `${n} of your payouts are parked and need you to say where they go.`} Open Parked.
    </button>
  );
}

export function ParkedPayouts({ parked }: { parked: ParkedState }) {
  return (
    <div className="space-y-6">
      <p className="leading-relaxed">
        Badge stakes go back into the pool on their own when a lock ends. If that deposit fails (someone used the
        payout&apos;s one-time code first, the pool was closed, or the amount is under its minimum), the coins aren&apos;t lost: they wait
        here, parked, until you say where they go. Sending them back into the pool keeps them private; a courier carries it, so your
        wallet never shows up.
      </p>
      <div className="flex items-center gap-3 text-sm text-lichen">
        <span>{parked.scanning ? "Looking…" : parked.items.length ? `${parked.items.length} need${parked.items.length === 1 ? "s" : ""} you.` : "Nothing is parked."}</span>
        <Button tone="quiet" busy={parked.scanning} onClick={() => parked.rescan()}>
          Check again
        </Button>
      </div>
      {parked.error && <Result out={{ tone: "error", text: `Couldn't check: ${parked.error}` }} />}
      <ul className="space-y-4">
        {parked.items.map((p) => (
          <ParkedItem key={p.key} p={p} onDone={() => setTimeout(() => parked.rescan(), 3000)} />
        ))}
      </ul>
    </div>
  );
}

type Choice = Recovery["action"];

function ParkedItem({ p, onDone }: { p: ParkedPayout; onDone: () => void }) {
  const w = useWallet();
  const options: Choice[] = p.state === "parked" ? ["redirect", "release"] : ["ragequit"];
  const [choice, setChoice] = useState<Choice>(p.state === "parked" ? (p.canRedirect ? "redirect" : "release") : "ragequit");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const needsTo = choice !== "redirect";

  const go = async () => {
    setBusy(true);
    setOut(null);
    try {
      if (!w.config || !w.pub || !w.zip || !w.notes) throw new Error("Unlock your zip key first.");
      if (needsTo && !isAddress(to)) throw new Error("Enter the address to send it to.");
      const r: Recovery = choice === "redirect" ? { action: "redirect" } : { action: choice, to: to as Address };
      const done = await recoverPayout(
        { config: w.config, pub: w.pub, keys: w.zip.keys, badgeIdentities: w.zip.identities.badges, nextDepositIndex: w.notes.nextDepositIndex },
        p,
        r,
      );
      setOut({ tone: "ok", text: done.text });
      onDone();
    } catch (e) {
      setOut({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-frost p-4">
      <p className="font-story text-lg leading-snug">{p.title}</p>
      <p className="mt-0.5 text-[0.8rem] text-lichen">
        {zc(p.amount)} ZC · {p.state === "parked" ? "parked" : "in the pool, never approved"}
      </p>
      <p className="mt-2 text-sm leading-relaxed">{p.explanation}</p>

      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Where it goes</legend>
        {options.map((o) => {
          const off = o === "redirect" && p.state === "parked" && !p.canRedirect;
          return (
            <label key={o} className={clsx("flex gap-2 text-sm", off && "opacity-50")}>
              <input type="radio" name={`parked-${p.key}`} checked={choice === o} disabled={off} onChange={() => setChoice(o)} className="mt-1" />
              <span>
                <strong className="font-medium">{LABEL[o]}</strong>
                <span className="block text-[0.8rem] text-lichen">{HINT[o]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {needsTo && (
        <div className="mt-3 space-y-2">
          <Field label="Send to" hint="A fresh address keeps the link from reaching your other wallets.">
            <input className={inputCls} placeholder={w.address ?? "0x…"} value={to} onChange={(e) => setTo(e.target.value.trim())} />
          </Field>
          <p className="rounded-md bg-candle/15 px-3 py-2 text-[0.8rem] text-pine">
            This is public: anyone can see that {to && isAddress(to) ? `${to.slice(0, 8)}…` : "the address"} received this payout
            , and which badge lock it came from.
          </p>
        </div>
      )}

      <Button tone={choice === "redirect" ? "pad" : "candle"} busy={busy} onClick={go} className="mt-3">
        {choice === "redirect" ? "Send it back into the pool" : choice === "release" ? "Send it to this address" : "Take it out to this address"}
      </Button>
      <Result out={out} />
    </li>
  );
}

const LABEL: Record<Choice, string> = {
  redirect: "Send back into the pool (private, recommended)",
  release: "Send to an address",
  ragequit: "Ragequit to an address",
};

const HINT: Record<Choice, string> = {
  redirect:
    "It goes back in under a fresh one-time code only your zip key knows, and comes back as an ordinary private note. A courier submits it with a one-time proof from the lock's own identity, so your wallet never appears.",
  release: "For when the pool can't take it (closed, or under its minimum), or you want it in a wallet now. The coins go straight to the address.",
  ragequit:
    "The pool's public exit for a note its approver won't clear. Only the badge contract can do this for you; it takes the note out and forwards the whole amount to the address. A courier submits it, but the address is public.",
};
