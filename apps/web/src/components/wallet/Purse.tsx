"use client";

import { zipAddressRegistryAbi } from "@zipnet/sdk";
import { useEffect, useState } from "react";
import type { Hex } from "viem";

import { ConnectPicker } from "./ConnectPicker";
import { Button, errorText, inputCls, zc } from "./ui";
import { useWallet } from "./WalletProvider";

/** Connection, zip key and balances: everything above the actions. */
export function Purse() {
  const w = useWallet();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [showPhrase, setShowPhrase] = useState(false);
  const [registered, setRegistered] = useState<boolean | null>(null);

  const act = (label: string, fn: () => Promise<unknown> | unknown) => async () => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!w.config || !w.pub || !w.address || !w.zip) return setRegistered(null);
    w.pub
      .readContract({ address: w.config.deployment.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [w.address] })
      .then((k) => setRegistered((k as Hex).toLowerCase() === w.zip!.publicKey.toLowerCase()));
  }, [w.config, w.pub, w.address, w.zip]);

  if (w.configError) return <p className="rounded-md bg-candle/15 px-4 py-3 text-sm">{w.configError}</p>;

  if (!w.address) {
    return (
      <div className="space-y-3">
        <p className="max-w-xl leading-relaxed">Connect a wallet to zip coins into the pool, send them privately, and pay with the sales tax included.</p>
        <ConnectPicker />
      </div>
    );
  }

  const connectedAs = (
    <span>
      {w.walletName ? `${w.walletName}: ` : ""}
      {w.address}{" "}
      <button className="underline underline-offset-2 hover:text-pine" onClick={act("disconnect", w.disconnect)}>
        Disconnect
      </button>
    </span>
  );

  if (!w.zip) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-lichen">Connected: {connectedAs}</p>
        <p className="max-w-xl leading-relaxed">
          Unlock your zip key by signing a message. The key is derived in this browser from the signature and never leaves it; the same
          wallet always unlocks the same coins.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button tone="pad" onClick={act("unlock", w.unlock)} busy={busy === "unlock"}>
            Unlock zip key
          </Button>
          <Button tone="quiet" onClick={() => setShowPhrase((s) => !s)}>
            Use a recovery phrase instead
          </Button>
        </div>
        {showPhrase && (
          <div className="flex max-w-xl gap-2">
            <input className={inputCls} placeholder="twelve words" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            <Button onClick={act("phrase", () => w.unlockWithPhrase(phrase))}>Unlock</Button>
          </div>
        )}
        {err && <p className="text-sm text-pine">{err}</p>}
      </div>
    );
  }

  const n = w.notes;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <div>
          <dd className="font-story text-3xl tabular-nums">{n ? zc(n.balance) : "…"}</dd>
          <dt className="text-sm text-lichen">ZC zipped</dt>
        </div>
        <div>
          <dd className="font-story text-3xl tabular-nums">{n ? zc(n.largest) : "…"}</dd>
          <dt className="text-sm text-lichen">largest note, the most you can move at once</dt>
        </div>
        <div>
          <dd className="font-story text-3xl tabular-nums">{n ? zc(n.waiting.reduce((a, x) => a + x.value, 0n)) : "…"}</dd>
          <dt className="text-sm text-lichen">ZC waiting to be cleared</dt>
        </div>
        <div>
          <dd className="font-story text-3xl tabular-nums">{zc(w.walletZc)}</dd>
          <dt className="text-sm text-lichen">ZC in your public wallet</dt>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-lichen">
        {connectedAs}
        {w.pool && !w.pool.verified && <span className="text-pine">The courier&apos;s view doesn&apos;t match the chain yet; retrying.</span>}
        {registered === false && (
          <Button
            tone="quiet"
            busy={busy === "register"}
            onClick={act("register", async () => {
              const hash = await w.wallet!.writeContract({
                account: w.wallet!.account!,
                chain: null,
                address: w.config!.deployment.addressRegistry,
                abi: zipAddressRegistryAbi,
                functionName: "setKey",
                args: [w.zip!.publicKey],
              });
              await w.pub!.waitForTransactionReceipt({ hash });
              setRegistered(true);
            })}
          >
            Set up my zip address so people can send to me
          </Button>
        )}
        {registered && <span>Your zip address is set up.</span>}
        <button className="underline underline-offset-2 hover:text-pine" onClick={() => setShowPhrase((s) => !s)}>
          {showPhrase ? "Hide recovery phrase" : "Show recovery phrase"}
        </button>
      </div>
      {showPhrase && <p className="mt-2 max-w-xl rounded-md bg-drift px-3 py-2 font-story text-lg">{w.zip.phrase}</p>}
      {err && <p className="mt-2 text-sm text-pine">{err}</p>}
    </div>
  );
}
