"use client";

import { encodeRelay, encodeSend, hashNullifier, hashPrecommitment, parseZipLink, randomSecrets, sealSecrets, type Note } from "@zipnet/sdk";
import { useEffect, useMemo, useState } from "react";

import { Button, Result, zc, type Outcome } from "@/components/wallet/ui";
import { useWallet } from "@/components/wallet/WalletProvider";
import { courierQuote, spend } from "@/lib/wallet";

export default function Claim() {
  const w = useWallet();
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  useEffect(() => setHash(window.location.hash), []);

  const secrets = useMemo(() => (hash ? parseZipLink(`x${hash}`) : null), [hash]);
  const found = useMemo(() => {
    if (!secrets || !w.pool) return null;
    const d = w.pool.state.deposits.find((x) => x.precommitment === hashPrecommitment(secrets.nullifier, secrets.secret));
    if (!d) return { status: "missing" as const };
    const spent = w.pool.state.withdrawals.some((x) => x.spentNullifier === hashNullifier(secrets.nullifier));
    const note: Note = { label: d.label, value: d.value, nullifier: secrets.nullifier, secret: secrets.secret, commitment: d.commitment, children: 0n, origin: "link" };
    return { status: spent ? ("claimed" as const) : w.pool.labels.includes(d.label) ? ("ready" as const) : ("waiting" as const), note };
  }, [secrets, w.pool]);

  const claim = (keep: boolean) => async () => {
    setBusy(true);
    setOut(null);
    try {
      if (!w.config || !w.pool || !found?.note) throw new Error("This link isn't ready to claim.");
      const q = await courierQuote(w.config);
      const v = found.note.value;
      if (keep) {
        if (!w.zip) throw new Error("Unlock your zip key first, so the coins land under it.");
        const s = randomSecrets();
        const fee = q.fee("rezip");
        const data = encodeSend({ precommitment: hashPrecommitment(s.nullifier, s.secret), ciphertext: sealSecrets(w.zip.publicKey, s), courier: { feeRecipient: q.courier, fee } });
        await spend(w.config, null, w.pool, found.note, v, "rezip", w.config.deployment.rezip, data, 0);
        setOut({ tone: "ok", text: `${zc(v - fee)} ZC moved under your zip key. It stays private and shows up in your wallet after the next epoch.` });
      } else {
        if (!w.address) throw new Error("Connect a wallet to receive the coins.");
        const fee = q.fee("relay");
        const bps = fee === 0n ? 0n : (fee * 10_000n + v - 1n) / v;
        await spend(w.config, null, w.pool, found.note, v, "relay", w.config.deployment.entrypoint, encodeRelay(w.address, q.courier, bps), 0);
        setOut({ tone: "ok", text: `${zc(v)} ZC is on its way to ${w.address.slice(0, 8)}….` });
      }
      setTimeout(w.refresh, 3000);
    } catch (e) {
      setOut({ tone: "error", text: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl pt-6">
      <h1 className="font-story text-4xl tracking-tight">Someone sent you zipcoins</h1>
      {!secrets && <p className="mt-4 leading-relaxed">This page opens zip links. The link you followed is missing its secret, which lives after the # in the address.</p>}
      {secrets && !w.pool && <p className="mt-4 text-lichen">Looking for the coins…</p>}
      {found?.status === "missing" && <p className="mt-4 leading-relaxed">No coins match this link yet. If it was just made, they appear once the courier delivers it.</p>}
      {found?.status === "claimed" && <p className="mt-4 leading-relaxed">This link has already been claimed.</p>}
      {found?.status === "waiting" && (
        <p className="mt-4 leading-relaxed">{zc(found.note!.value)} ZC is waiting for the next approval epoch. Come back in a little while.</p>
      )}
      {found?.status === "ready" && (
        <>
          <p className="mt-4 font-story text-3xl">{zc(found.note!.value)} ZC</p>
          <p className="mt-2 max-w-xl leading-relaxed text-pine/85">
            Nobody but you and the sender knows this link exists. Take the coins to a wallet, or keep them zipped under your own key.
          </p>
          {!w.address && (
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => w.connectInjected().catch((e) => setOut({ tone: "error", text: e.message }))}>Connect wallet</Button>
              {w.config?.devWallet && (
                <Button tone="quiet" onClick={() => w.connectDev().catch((e) => setOut({ tone: "error", text: e.message }))}>
                  Use a dev wallet
                </Button>
              )}
            </div>
          )}
          {w.address && (
            <div className="mt-6 flex flex-wrap gap-3">
              <Button tone="pine" busy={busy} onClick={claim(false)}>
                Send to my wallet
              </Button>
              {w.zip ? (
                <Button tone="pad" busy={busy} onClick={claim(true)}>
                  Keep it zipped
                </Button>
              ) : (
                <Button tone="quiet" onClick={() => w.unlock().catch((e) => setOut({ tone: "error", text: e.message }))}>
                  Unlock zip key to keep it zipped
                </Button>
              )}
            </div>
          )}
        </>
      )}
      <Result out={out} />
    </div>
  );
}
