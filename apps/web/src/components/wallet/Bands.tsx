"use client";

import { bandsStatus, type BandsStatus, type BandStatus } from "@zipnet/sdk";
import clsx from "clsx";
import { useEffect, useState } from "react";

import { zc } from "./ui";
import { useWallet } from "./WalletProvider";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** An FDV in ETH, readable across ten orders of magnitude */
function eth(n: number): string {
  if (n > 1e12) return "∞";
  if (n < 0.01) return "about 0";
  return n < 10 ? n.toPrecision(2) : Math.round(n).toLocaleString("en-US");
}

function range(b: BandStatus): string {
  const [lo, hi] = b.fdv;
  return hi > 1e12 ? `above ${eth(lo)}` : `${eth(lo)} to ${eth(hi)}`;
}

function when(sec: number): string {
  return sec === 0 ? "none yet" : new Date(sec * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Read-only view of ZipLiquidityBands: the treasury's tax share (ZC) placed as one-sided liquidity in ZC's pool, in
 * fixed bands above the locked launch position only. Nothing here moves funds; couriers run the contract's public calls.
 */
export function Bands() {
  const w = useWallet();
  const dep = w.config?.deployment;
  const [s, setS] = useState<BandsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dep?.bands || !w.pub) return;
    let live = true;
    bandsStatus(w.pub, dep).then(
      (r) => live && setS(r),
      (e: Error) => live && setError(e.message.split("\n")[0]),
    );
    return () => {
      live = false;
    };
  }, [dep, w.pub]);

  if (!dep?.bands) return <p className="text-sm text-lichen">The treasury liquidity bands aren&apos;t deployed on this network.</p>;
  if (error) return <p className="text-sm text-lichen">Couldn&apos;t read the bands contract: {error}</p>;
  if (!s) return <p className="font-story italic text-lichen">Reading the bands…</p>;

  const feesEth = s.bands.reduce((t, b) => t + b.feesEth, 0n);
  const feesZc = s.bands.reduce((t, b) => t + b.feesZc, 0n);
  return (
    <div className="space-y-5">
      <p className="leading-relaxed">
        The treasury&apos;s share of the sales tax (ZC) is placed as liquidity in ZC&apos;s Uniswap v4 pool, only above the
        range the locked launch position covers (fully diluted about 2.9 to 2,875 ETH), by a contract with fixed rules.
        Nothing is added below that range, and no ETH is added at all: ETH that reaches the contract goes to the treasury
        Safe ({short(s.safe)}), which also owns the positions and their fees. They are not a price floor or price
        support, and they do not pay holders.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-lichen">
            <tr>
              <th className="py-1 pr-3 font-normal">Band</th>
              <th className="py-1 pr-3 font-normal">FDV range (ETH)</th>
              <th className="py-1 pr-3 font-normal">Share</th>
              <th className="py-1 pr-3 font-normal">Added</th>
              <th className="py-1 pr-3 font-normal">Fees to the Safe</th>
              <th className="py-1 font-normal">Price</th>
            </tr>
          </thead>
          <tbody>
            {s.bands.map((b) => (
              <tr key={b.name} className="border-t border-frost">
                <td className="py-1 pr-3 font-mono">{b.name}</td>
                <td className="py-1 pr-3">{range(b)}</td>
                <td className="py-1 pr-3">{b.weightBps / 100}%</td>
                <td className="py-1 pr-3">{b.tokenId === 0n ? "nothing yet" : `${zc(b.zcIn)} ZC`}</td>
                <td className="py-1 pr-3">
                  {zc(b.feesEth)} ETH, {zc(b.feesZc)} ZC
                </td>
                <td className={clsx("py-1", !b.outOfRange && "font-medium")}>{b.outOfRange ? "outside" : "inside or past"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-lichen">Last deposit: </dt>
          <dd className="inline">{when(s.lastDeposit)}</dd>
        </div>
        <div>
          <dt className="inline text-lichen">Fees sent to the Safe: </dt>
          <dd className="inline">
            {zc(feesEth)} ETH, {zc(feesZc)} ZC
          </dd>
        </div>
        <div>
          <dt className="inline text-lichen">Waiting to be added: </dt>
          <dd className="inline">
            {s.depositable.ok ? `${zc(s.depositable.zc)} ZC` : "nothing yet"}
          </dd>
        </div>
        <div>
          <dt className="inline text-lichen">ETH waiting to go to the Safe: </dt>
          <dd className="inline">{zc(s.ethToForward)} ETH</dd>
        </div>
        <div>
          <dt className="inline text-lichen">Limits: </dt>
          <dd className="inline">
            {zc(s.caps.dayZc)} ZC a day, every {Math.round(s.caps.minInterval / 3600)}h at most
          </dd>
        </div>
        {(s.paused || s.forwardAll) && (
          <div className="sm:col-span-2">
            <dt className="inline text-lichen">State: </dt>
            <dd className="inline">{s.forwardAll ? "retired: everything goes straight to the Safe" : "paused by the Safe"}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
