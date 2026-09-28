"use client";

import {
  encodeKnock,
  encodePayment,
  encodeRelay,
  encodeSend,
  encodeSpeech,
  hashPrecommitment,
  randomSecrets,
  sealSecrets,
  zipAddressRegistryAbi,
  zipBroadcasterAbi,
  zipLink,
  zipPayAbi,
} from "@zipnet/sdk";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { isAddress, keccak256, parseAbiItem, toHex, type Address, type Hex } from "viem";

import { courierQuote, pickNote, spend, zip, type JobResult } from "@/lib/wallet";

import { Badges, Board, Polls } from "./Signal";
import { Button, Field, Hold, inputCls, Result, toWei, zc, type Outcome } from "./ui";
import { useWallet } from "./WalletProvider";

const TABS = ["Zip", "Send", "Pay", "Unzip", "Speak", "Knock", "Badges", "Board", "Polls"] as const;
type Tab = (typeof TABS)[number];

const when = (j: JobResult) =>
  j.tx
    ? `Sent on-chain in transaction ${j.tx.slice(0, 10)}…`
    : `The courier will send it by ${new Date(j.deadline * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}, at a random moment. It signed a promise to.`;

/** Shared plumbing for every spend: pick a note, prove, hand to the courier. */
function useSpend() {
  const w = useWallet();
  return async (amount: bigint, kind: string, processooor: Address, data: Hex, holdSec: number) => {
    if (!w.config || !w.zip || !w.pool || !w.notes) throw new Error("Unlock your zip key first.");
    const note = pickNote(w.notes.spendable, amount);
    if (!note) throw new Error(`Your largest cleared note holds ${zc(w.notes.largest)} ZC. One action spends one note, so send less or zip more first.`);
    const job = await spend(w.config, w.zip.keys, w.pool, note, amount, kind, processooor, data, holdSec);
    setTimeout(w.refresh, 3000);
    return job;
  };
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const run = async (fn: () => Promise<Outcome>) => {
    setBusy(true);
    setOut(null);
    try {
      setOut(await fn());
    } catch (e) {
      setOut({ tone: "error", text: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(false);
    }
  };
  return { busy, out, run };
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
        run(async () => {
          if (!w.config || !w.pub || !w.wallet || !w.zip || !w.notes || !v) throw new Error("Connect, unlock and enter an amount.");
          if (v > w.walletZc) throw new Error(`Your wallet holds ${zc(w.walletZc)} ZC.`);
          await zip(w.config, w.pub, w.wallet, w.zip.keys, w.notes.nextDepositIndex, v);
          await w.refresh();
          return { tone: "ok", text: `Zipped ${zc(v)} ZC. It becomes spendable once the postman clears it at the next epoch.` };
        });
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
  const doSpend = useSpend();
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
        run(async () => {
          if (!w.config || !w.pub || !v) throw new Error("Enter an amount.");
          const s = randomSecrets();
          let ciphertext: Hex = "0x";
          if (!asLink) {
            if (!isAddress(to)) throw new Error("Enter the recipient's address, or make a link instead.");
            const key = (await w.pub.readContract({ address: w.config.deployment.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [to] })) as Hex;
            if (/^0x0+$/.test(key)) throw new Error("That address hasn't set up a zip address yet. Send them a link instead.");
            ciphertext = sealSecrets(key, s);
          }
          const q = await courierQuote(w.config);
          const data = encodeSend({ precommitment: hashPrecommitment(s.nullifier, s.secret), ciphertext, courier: { feeRecipient: q.courier, fee: q.fee("rezip") } });
          const job = await doSpend(v + q.fee("rezip"), "rezip", w.config.deployment.rezip, data, hold);
          if (asLink) return { tone: "ok", text: `Link ready. Whoever opens it can claim ${zc(v)} ZC, so share it like cash. ${when(job)}`, link: zipLink(window.location.origin, s) };
          return { tone: "ok", text: `${zc(v)} ZC is on its way to ${to.slice(0, 8)}…; it stays inside the pool the whole time. ${when(job)}` };
        });
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
        <Field label="Recipient" hint="Their wallet address. They need a zip address, which the app sets up on first unlock.">
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

type Shop = { id: bigint; name: string };
const registered = parseAbiItem("event Registered(uint256 indexed merchantId, address indexed signer, address payout, uint256 stake, string metadataURI)");

function PayForm() {
  const w = useWallet();
  const doSpend = useSpend();
  const [shops, setShops] = useState<Shop[]>([]);
  const [shop, setShop] = useState("");
  const [amount, setAmount] = useState("");
  const [taxBps, setTaxBps] = useState(0n);
  const { busy, out, run } = useRun();
  useEffect(() => {
    if (!w.config || !w.pub) return;
    w.pub.getLogs({ address: w.config.deployment.merchants, event: registered, fromBlock: BigInt(w.config.deployment.deployBlock) }).then((logs) =>
      setShops(logs.map((l) => ({ id: l.args.merchantId!, name: (l.args.metadataURI ?? "").replace(/^veridia:/, "") || `Merchant ${l.args.merchantId}` }))),
    );
    w.pub.readContract({ address: w.config.deployment.pay, abi: zipPayAbi, functionName: "TAX_BPS" }).then((t) => setTaxBps(t as bigint));
  }, [w.config, w.pub]);
  const base = toWei(amount);
  const tax = base ? (base * taxBps) / 10_000n : 0n;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (!w.config || !base || !shop) throw new Error("Pick a merchant and an amount.");
          const q = await courierQuote(w.config);
          const data = encodePayment({
            merchantId: BigInt(shop),
            base,
            orderId: keccak256(toHex(`${Date.now()}-${Math.random()}`)),
            payeePrecommitment: 0n,
            identityCommitment: 0n,
            receipt: "0x",
            courier: { feeRecipient: q.courier, fee: q.fee("pay") },
          });
          const job = await doSpend(base + tax + q.fee("pay"), "pay", w.config.deployment.pay, data, 0);
          return { tone: "ok", text: `Payment succeeded. Base ${zc(base)} zc, tax ${zc(tax)} zc, total ${zc(base + tax)} zc. The merchant knows it was paid; nobody knows by whom. ${when(job)}` };
        });
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
      <Field label="Price" hint={base ? `Tax ${zc(tax)} zc, sent in real time: part burned, part to the couriers, part to the treasury.` : "Sales tax is added at checkout."}>
        <input className={inputCls} inputMode="decimal" placeholder="10.5" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Button type="submit" tone="pad" busy={busy} disabled={!base || !shop}>
        {base ? `Pay ${zc(base + tax)} zc` : "Pay"}
      </Button>
      <Result out={out} />
    </form>
  );
}

function UnzipForm() {
  const w = useWallet();
  const doSpend = useSpend();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [hold, setHold] = useState(3600);
  const { busy, out, run } = useRun();
  const v = toWei(amount);
  const dest = to || w.address || "";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (!w.config || !v || !isAddress(dest)) throw new Error("Enter an amount and a destination.");
          const q = await courierQuote(w.config);
          const fee = q.fee("relay");
          const bps = fee === 0n ? 0n : (fee * 10_000n + v - 1n) / v;
          const data = encodeRelay(dest, q.courier, bps);
          const job = await doSpend(v, "relay", w.config.deployment.entrypoint, data, hold);
          return { tone: "ok", text: `${zc(v)} ZC will arrive at ${dest.slice(0, 8)}… with no link to where it came from. ${when(job)}` };
        });
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
  const w = useWallet();
  const doSpend = useSpend();
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("");
  const [burn, setBurn] = useState("");
  const [minBurn, setMinBurn] = useState(0n);
  const [hold, setHold] = useState(0);
  const { busy, out, run } = useRun();
  useEffect(() => {
    if (w.config && w.pub) w.pub.readContract({ address: w.config.deployment.broadcaster, abi: zipBroadcasterAbi, functionName: "MIN_BURN" }).then((m) => setMinBurn(m as bigint));
  }, [w.config, w.pub]);
  const v = toWei(burn);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (!w.config || !v || !message) throw new Error("Write a message and choose a burn.");
          if (v < minBurn) throw new Error(`The smallest burn is ${zc(minBurn)} ZC.`);
          const q = await courierQuote(w.config);
          const data = encodeSpeech({ topic: keccak256(toHex("zipnet")), groupId: 0n, message, target, payload: "", courier: { feeRecipient: q.courier, fee: q.fee("speak") } });
          const job = await doSpend(v + q.fee("speak"), "speak", w.config.deployment.broadcaster, data, hold);
          return { tone: "ok", text: `${zc(v)} ZC will burn to carry your words, signed by nobody. ${when(job)}` };
        });
      }}
      className="space-y-4"
    >
      <Field label="Message" hint={`${message.length}/280`}>
        <textarea className={clsx(inputCls, "min-h-24")} maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Field label="Who it's for (optional)" hint={'Describe them without naming them, e.g. "someone who ate at Beautiful Plants, 18, successful".'}>
        <input className={inputCls} maxLength={120} value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <Field label="Burn" hint={`At least ${zc(minBurn)} ZC. Readers and their filters rank messages by it.`}>
        <input className={inputCls} inputMode="decimal" placeholder={zc(minBurn)} value={burn} onChange={(e) => setBurn(e.target.value)} />
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
  const w = useWallet();
  const doSpend = useSpend();
  const [door, setDoor] = useState("");
  const [burn, setBurn] = useState("");
  const [gift, setGift] = useState("");
  const [message, setMessage] = useState("");
  const { busy, out, run } = useRun();
  const v = toWei(burn);
  const g = toWei(gift) ?? 0n;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (!w.config || !v || !isAddress(door)) throw new Error("Enter whose door and how much to burn.");
          const q = await courierQuote(w.config);
          const data = encodeKnock({ door, gift: g, message, courier: { feeRecipient: q.courier, fee: q.fee("knock") } });
          const job = await doSpend(v + g + q.fee("knock"), "knock", w.config.deployment.doorstep, data, 0);
          return { tone: "ok", text: `${zc(v)} ZC will burn at their door${g ? `, with a gift of ${zc(g)} ZC` : ""}. If they subscribed with a courier, their phone buzzes. ${when(job)}` };
        });
      }}
      className="space-y-4"
    >
      <Field label="Whose door" hint="Their wallet address.">
        <input className={inputCls} placeholder="0x…" value={door} onChange={(e) => setDoor(e.target.value.trim())} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Burn">
          <input className={inputCls} inputMode="decimal" placeholder="100" value={burn} onChange={(e) => setBurn(e.target.value)} />
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

export function Actions() {
  const w = useWallet();
  const [tab, setTab] = useState<Tab>("Zip");
  if (!w.zip) return null;
  return (
    <section>
      <div role="tablist" aria-label="What to do" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-frost">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={clsx("-mb-px border-b-2 pb-2 font-story text-lg", tab === t ? "border-pine text-pine" : "border-transparent text-lichen hover:text-pine")}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={clsx("pt-6", tab === "Board" || tab === "Polls" || tab === "Badges" ? "max-w-2xl" : "max-w-lg")}>
        {tab === "Zip" && <ZipForm />}
        {tab === "Send" && <SendForm />}
        {tab === "Pay" && <PayForm />}
        {tab === "Unzip" && <UnzipForm />}
        {tab === "Speak" && <SpeakForm />}
        {tab === "Knock" && <KnockForm />}
        {tab === "Badges" && <Badges />}
        {tab === "Board" && <Board />}
        {tab === "Polls" && <Polls />}
      </div>
    </section>
  );
}
