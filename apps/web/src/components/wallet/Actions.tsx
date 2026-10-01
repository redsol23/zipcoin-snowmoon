"use client";

import { zipDoorstepAbi } from "@zipnet/sdk";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { parseAbiItem, type Address } from "viem";

import { doKnock, doPay, doSend, doSpeak, doUnzip, doZip, minBurn, taxOn, type Ctx, type Done } from "@/lib/actions";

import { Bands } from "./Bands";
import { Emerald } from "./Emerald";
import { ParkedNotice, ParkedPayouts, useParkedPayouts } from "./Parked";
import { Badges, Board, Polls } from "./Signal";
import { Button, errorText, Field, Hold, inputCls, Result, toWei, zc, type Outcome } from "./ui";
import { useCtx, useWallet } from "./WalletProvider";

/** Tabs grouped by what a person is trying to do; the group names are row labels, not tabs. */
const GROUPS = [
  { name: "Money", tabs: ["Emerald", "Zip", "Send", "Pay", "Unzip", "Parked"] },
  { name: "Voice", tabs: ["Speak", "Knock", "Board", "Polls"] },
  { name: "Standing", tabs: ["Badges", "Treasury"] },
] as const;
type Tab = (typeof GROUPS)[number]["tabs"][number];

/** Runs an action against the current context and turns the result or error into an Outcome. */
function useRun() {
  const ctx = useCtx();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const run = async (fn: (c: Ctx) => Promise<Done>) => {
    setBusy(true);
    setOut(null);
    try {
      if (!ctx) throw new Error("Unlock your zip key first.");
      const d = await fn(ctx);
      setOut({ tone: "ok", text: d.text, link: d.link });
    } catch (e) {
      setOut({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return { ctx, busy, out, run };
}

function ZipForm() {
  const w = useWallet();
  const [amount, setAmount] = useState("");
  const { busy, out, run } = useRun();
  const v = toWei(amount);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v) run((c) => doZip(c, v));
      }}
      className="space-y-4"
    >
      <Field label="Amount to zip" hint={`From your wallet (${zc(w.walletZc)} ZC). Two transactions: an approval, then the deposit.`}>
        <input className={inputCls} inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Button type="submit" tone="pad" busy={busy} disabled={!v}>
        Zip {v ? `${zc(v)} ZC` : ""}
      </Button>
      <Result out={out} />
    </form>
  );
}

function SendForm() {
  const w = useWallet();
  const [to, setTo] = useState("");
  const [asLink, setAsLink] = useState(false);
  const [amount, setAmount] = useState("");
  const [hold, setHold] = useState(0);
  const { busy, out, run } = useRun();
  const v = toWei(amount);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v) run((c) => doSend(c, v, asLink ? null : to, hold));
      }}
      className="space-y-4"
    >
      <div className="flex gap-4 text-sm">
        {["To an address", "As a link"].map((l, i) => (
          <label key={l} className="flex items-center gap-2">
            <input type="radio" checked={asLink === (i === 1)} onChange={() => setAsLink(i === 1)} />
            {l}
          </label>
        ))}
      </div>
      {!asLink && (
        <Field label="Recipient" hint="Their wallet address. They need a zip address, which they set up once on their own wallet page.">
          <input className={inputCls} placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
        </Field>
      )}
      <Field label="Amount" hint={w.notes ? `Up to ${zc(w.notes.largest)} ZC in one send.` : undefined}>
        <input className={inputCls} inputMode="decimal" placeholder="25" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Hold value={hold} onChange={setHold} />
      <Button type="submit" tone="pad" busy={busy} disabled={!v}>
        {asLink ? "Make the link" : "Send privately"}
      </Button>
      <Result out={out} />
    </form>
  );
}

export type Shop = { id: bigint; name: string; payout: Address };
const registered = parseAbiItem("event Registered(uint256 indexed merchantId, address indexed signer, address payout, uint256 stake, string metadataURI)");

export function useShops() {
  const w = useWallet();
  const [shops, setShops] = useState<Shop[]>([]);
  useEffect(() => {
    if (!w.config || !w.pub) return;
    w.pub
      .getLogs({ address: w.config.deployment.merchants, event: registered, fromBlock: BigInt(w.config.deployment.deployBlock) })
      .then((logs) =>
        setShops(
          logs.map((l) => ({
            id: l.args.merchantId!,
            name: (l.args.metadataURI ?? "").replace(/^veridia:/, "") || `Merchant ${l.args.merchantId}`,
            payout: l.args.payout!,
          })),
        ),
      );
  }, [w.config, w.pub]);
  return shops;
}

function PayForm() {
  const shops = useShops();
  const [shop, setShop] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState(0n);
  const { ctx, busy, out, run } = useRun();
  const base = toWei(amount);
  useEffect(() => {
    if (ctx && base) taxOn(ctx, base).then(setTax);
    else setTax(0n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, !!ctx]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (base && shop) run((c) => doPay(c, BigInt(shop), base));
      }}
      className="space-y-4"
    >
      <Field label="Merchant">
        <select className={inputCls} value={shop} onChange={(e) => setShop(e.target.value)}>
          <option value="">Choose a merchant</option>
          {shops.map((s) => (
            <option key={s.id.toString()} value={s.id.toString()}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Price" hint={base ? `Tax ${zc(tax)} ZC, sent in real time: part burned, part to the couriers, part to the treasury.` : "Sales tax is added at checkout."}>
        <input className={inputCls} inputMode="decimal" placeholder="10.5" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Button type="submit" tone="pad" busy={busy} disabled={!base || !shop}>
        {base ? `Pay ${zc(base + tax)} ZC` : "Pay"}
      </Button>
      <Result out={out} />
    </form>
  );
}

function UnzipForm() {
  const w = useWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [hold, setHold] = useState(3600);
  const { busy, out, run } = useRun();
  const v = toWei(amount);
  const dest = (to || w.address || "") as Address;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v) run((c) => doUnzip(c, v, dest, hold));
      }}
      className="space-y-4"
    >
      <Field label="Send to" hint="A fresh address breaks the trail best. Defaults to your connected wallet.">
        <input className={inputCls} placeholder={w.address ?? "0x…"} value={to} onChange={(e) => setTo(e.target.value.trim())} />
      </Field>
      <Field label="Amount">
        <input className={inputCls} inputMode="decimal" placeholder="50" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Hold value={hold} onChange={setHold} />
      <Button type="submit" tone="pine" busy={busy} disabled={!v}>
        Unzip
      </Button>
      <Result out={out} />
    </form>
  );
}

function SpeakForm() {
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("");
  const [burn, setBurn] = useState("");
  const [floor, setFloor] = useState(0n);
  const [hold, setHold] = useState(0);
  const { ctx, busy, out, run } = useRun();
  useEffect(() => {
    if (ctx) minBurn(ctx).then(setFloor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!ctx]);
  const v = toWei(burn);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v) run((c) => doSpeak(c, v, message, target, hold));
      }}
      className="space-y-4"
    >
      <Field label="Message" hint={`${message.length}/280`}>
        <textarea className={clsx(inputCls, "min-h-24")} maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Field label="Who it's for (optional)" hint={'Describe them without naming them, e.g. "someone who ate at Beautiful Plants, 18, successful".'}>
        <input className={inputCls} maxLength={120} value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <Field label="Burn" hint={`At least ${zc(floor)} ZC. Readers and their filters rank messages by it.`}>
        <input className={inputCls} inputMode="decimal" placeholder={zc(floor)} value={burn} onChange={(e) => setBurn(e.target.value)} />
      </Field>
      <Hold value={hold} onChange={setHold} />
      <Button type="submit" tone="candle" busy={busy} disabled={!v || !message}>
        Burn and speak
      </Button>
      <Result out={out} />
    </form>
  );
}

function KnockForm() {
  const [door, setDoor] = useState("");
  const [burn, setBurn] = useState("");
  const [gift, setGift] = useState("");
  const [message, setMessage] = useState("");
  const [floor, setFloor] = useState(0n);
  const { ctx, busy, out, run } = useRun();
  useEffect(() => {
    if (ctx) ctx.pub.readContract({ address: ctx.config.deployment.doorstep, abi: zipDoorstepAbi, functionName: "MIN_BURN" }).then(setFloor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!ctx]);
  const v = toWei(burn);
  const g = toWei(gift) ?? 0n;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!v) return;
        run(async (c) => {
          // The doorstep checks these too, but only after a proof is made and a courier has simulated it
          if (v < floor) throw new Error(`The smallest burn at a door is ${zc(floor)} ZC.`);
          if (g > v * 10n) throw new Error("A gift can be at most ten times the burn.");
          return doKnock(c, door as Address, v, g, message);
        });
      }}
      className="space-y-4"
    >
      <Field label="Whose door" hint="Their wallet address.">
        <input className={inputCls} placeholder="0x…" value={door} onChange={(e) => setDoor(e.target.value.trim())} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Burn" hint={floor ? `At least ${zc(floor)} ZC.` : undefined}>
          <input className={inputCls} inputMode="decimal" placeholder={floor ? zc(floor) : "100"} value={burn} onChange={(e) => setBurn(e.target.value)} />
        </Field>
        <Field label="Gift (optional)" hint="At most ten times the burn.">
          <input className={inputCls} inputMode="decimal" placeholder="0" value={gift} onChange={(e) => setGift(e.target.value)} />
        </Field>
      </div>
      <Field label="Message (optional)">
        <input className={inputCls} maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Button type="submit" tone="candle" busy={busy} disabled={!v}>
        Burn at their door
      </Button>
      <Result out={out} />
    </form>
  );
}

/** Tabs for contracts a deployment may leave out (the liquidity bands are deployed only with the pool config). */
const NEEDS: Partial<Record<Tab, "bands">> = { Treasury: "bands" };

const WIDE: Tab[] = ["Emerald", "Parked", "Badges", "Board", "Polls", "Treasury"];

export function Actions() {
  const w = useWallet();
  const [tab, setTab] = useState<Tab>("Emerald");
  const parked = useParkedPayouts();
  if (!w.zip) return null;
  const dep = w.config?.deployment;
  const shown = (t: Tab) => {
    const need = NEEDS[t];
    return !need || !!dep?.[need];
  };
  return (
    <section>
      {tab !== "Parked" && <ParkedNotice parked={parked} onOpen={() => setTab("Parked")} />}
      <div role="tablist" aria-label="What to do" className="space-y-1 border-b border-frost pb-1">
        {GROUPS.map((g) => (
          <div key={g.name} className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <span className="w-20 shrink-0 text-sm text-lichen">{g.name}</span>
            {g.tabs.filter(shown).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={clsx("border-b-2 pb-1 font-story text-lg", tab === t ? "border-pine text-pine" : "border-transparent text-lichen hover:text-pine")}
              >
                {t}
                {t === "Parked" && parked.items.length > 0 && (
                  <span aria-label={`${parked.items.length} parked`} className="ml-1 inline-block h-2 w-2 rounded-full bg-candle align-super" />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div role="tabpanel" className={clsx("pt-6", WIDE.includes(tab) ? "max-w-2xl" : "max-w-lg")} hidden={!shown(tab)}>
        {tab === "Emerald" && <Emerald />}
        {tab === "Zip" && <ZipForm />}
        {tab === "Send" && <SendForm />}
        {tab === "Pay" && <PayForm />}
        {tab === "Unzip" && <UnzipForm />}
        {tab === "Parked" && <ParkedPayouts parked={parked} />}
        {tab === "Speak" && <SpeakForm />}
        {tab === "Knock" && <KnockForm />}
        {tab === "Badges" && <Badges />}
        {tab === "Board" && <Board />}
        {tab === "Polls" && <Polls />}
        {tab === "Treasury" && <Bands />}
      </div>
    </section>
  );
}
