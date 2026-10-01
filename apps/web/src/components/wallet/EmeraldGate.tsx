"use client";

import { groupMembers, proveMembership, toJson, zipBadgesAbi } from "@zipnet/sdk";
import { useEffect, useState } from "react";
import { formatEther, type Hex } from "viem";

import type { Ctx } from "@/lib/actions";
import { EMERALD_MESSAGE, emeraldScope } from "@/lib/emerald/scope";

import { ConnectPicker } from "./ConnectPicker";
import { Button, errorText } from "./ui";
import { useWallet } from "./WalletProvider";

/**
 * Emerald is for ZC holders; the server enforces it, this panel only helps. One private way in (a badge proof) and
 * one that links the wallet (signing a challenge). Whatever it gets is kept in memory only: closing the tab signs out.
 */

export type GateOptions = {
  emerald: {
    badge: { minTier: number; scope: string; message: string; epoch: number; chainId?: number };
    wallet: { minHoldWei: string };
  };
};

export type Access = { kind: "badge" | "wallet"; token: string; expiresAt: number };

const zc = (wei: string | bigint) => Number(formatEther(BigInt(wei))).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function useGateOptions() {
  const [options, setOptions] = useState<GateOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/emerald")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Emerald isn't available right now.");
        setOptions(j as GateOptions);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return { options, error };
}

export function EmeraldGate({ options, ctx, onAccess }: { options: GateOptions; ctx: Ctx | null; onAccess: (a: Access) => void }) {
  const w = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { badge, wallet } = options.emerald;

  const run = (what: string, fn: () => Promise<void>) => async () => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const session = async (body: unknown) => {
    const r = await fetch("/api/emerald/session", { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Emerald didn't accept that.");
    onAccess({ kind: j.kind, token: j.token, expiresAt: j.expiresAt });
  };

  const withBadge = run("badge", async () => {
    if (!ctx || !w.zip) throw new Error("Unlock your zip key first.");
    const dep = ctx.config.deployment;
    // The scope changes every epoch, so ask for the current epoch right before proving. Only the epoch (and chain)
    // come from the server: scope and message are computed here, so the server can't have us prove over some other
    // action's scope and message (A-9).
    const fresh = (await (await fetch("/api/emerald")).json()) as GateOptions;
    const b = fresh.emerald?.badge ?? badge;
    if (b.chainId !== undefined && b.chainId !== Number(dep.chainId)) throw new Error("Emerald is set up for another chain.");
    if (!Number.isSafeInteger(b.epoch) || b.epoch < 0) throw new Error("Emerald sent an unusable epoch.");
    const scope = emeraldScope(Number(dep.chainId), b.epoch);
    const message = EMERALD_MESSAGE;
    if (b.scope !== scope.toString() || b.message !== message.toString()) throw new Error("Emerald asked for a proof over something other than its sign-in, so none was made.");
    const n = Number(await ctx.pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierCount" }));
    // Highest tier first: any qualifying badge works, and the proof shows only the group, not which holder
    for (let tier = n; tier >= Math.max(1, badge.minTier); tier--) {
      const group = (await ctx.pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [BigInt(tier - 1)] })) as bigint;
      const members = await groupMembers(ctx.pub, dep.semaphore, group, BigInt(dep.deployBlock));
      const identity = w.zip.proverFor(members);
      if (!identity) continue;
      const proof = await proveMembership(identity, members, message, scope);
      return session({ kind: "badge", tier, proof });
    }
    throw new Error(`You don't hold a tier ${badge.minTier} badge or higher yet. Earn one on the Badges tab.`);
  });

  const withWallet = run("wallet", async () => {
    if (!w.wallet?.account || !w.address) throw new Error("Connect a wallet first.");
    const r = await fetch(`/api/emerald/challenge?address=${w.address}`);
    const c = (await r.json()) as { message?: string; error?: string };
    if (!r.ok || !c.message) throw new Error(c.error ?? "Couldn't get a sign-in message.");
    const signature: Hex = await w.wallet.signMessage({ account: w.wallet.account, message: c.message });
    await session({ kind: "wallet", address: w.address, message: c.message, signature });
  });

  return (
    <section className="mt-6 rounded-md border border-frost p-4">
      <p className="font-story text-lg">Emerald is for zipcoin holders</p>
      <p className="mt-1 text-sm text-lichen">Choose how to show it. A badge keeps you private.</p>
      <ul className="mt-4 space-y-4">
        <li>
          <Button tone="pad" busy={busy === "badge"} disabled={!!busy} onClick={withBadge}>
            Hold a badge (private)
          </Button>
          <p className="mt-1 text-sm text-lichen">
            Proves you hold a tier {badge.minTier}+ badge without saying which one is yours. Lasts up to an hour, within this epoch.
          </p>
        </li>
        <li>
          {w.address ? (
            <Button tone="quiet" busy={busy === "wallet"} disabled={!!busy} onClick={withWallet}>
              Sign with wallet (links your wallet)
            </Button>
          ) : (
            <>
              <p className="text-sm font-medium">Sign with wallet (links your wallet): connect one first</p>
              <ConnectPicker className="mt-2" />
            </>
          )}
          <p className="mt-1 rounded-md bg-candle/15 px-3 py-2 text-sm">
            Needs {zc(wallet.minHoldWei)} ZC in your wallet. Signing tells this server which wallet is talking to Emerald, and that wallet is public
            on-chain. Use a badge to stay private.
          </p>
        </li>
      </ul>
      {error && <p className="mt-3 rounded-md bg-candle/15 px-3 py-2 text-sm">{error}</p>}
    </section>
  );
}
