"use client";

import { zipAddressRegistryAbi, zipBadgesAbi, zipPayAbi } from "@zipnet/sdk";
import clsx from "clsx";
import { useRef, useState } from "react";
import { formatEther, isAddress, parseAbiItem, parseEther, type Address, type Hex } from "viem";

import { doKnock, doPay, doSend, doSpeak, doUnzip, doZip, type Ctx } from "@/lib/actions";

import { useShops, type Shop } from "./Actions";
import { Button, inputCls } from "./ui";
import { useCtx, useWallet } from "./WalletProvider";

/**
 * Emerald, the wallet's assistant. The conversation lives here; the server only relays one model call per step.
 * Tools run in this browser against the person's own wallet, so what Emerald learns is exactly what a tool result
 * says, never keys or note secrets. Emerald can only propose; a card waits for the person to confirm.
 */

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: string; [k: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

type Proposal = {
  id: string;
  action: "zip" | "send" | "send_link" | "pay" | "unzip" | "speak" | "knock";
  amount_zc: string;
  to: string | null;
  merchant_id: string | null;
  message: string | null;
  target: string | null;
  hold: "now" | "hour" | "epoch";
  reason: string;
  state: "open" | "running" | "done" | "dismissed" | "failed";
  result?: string;
  link?: string;
};

const HOLD = { now: 0, hour: 3600, epoch: 86_400 };
const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const knocked = parseAbiItem("event Knocked(address indexed door, address indexed knocker, uint256 nullifierHash, uint256 burned, uint256 gift, uint256 fee, string message)");
const posted = parseAbiItem("event Posted(uint256 indexed groupId, uint256 indexed day, uint256 nullifier, string message)");
const pollCreated = parseAbiItem(
  "event PollCreated(uint256 indexed pollId, uint256 indexed groupId, address indexed creator, uint256 burned, uint256 rewardPerVote, uint256 maxVotes, uint64 endsAt, uint8 optionCount, string question)",
);

async function runTool(name: string, input: Record<string, unknown>, c: Ctx, w: ReturnType<typeof useWallet>, shops: Shop[]): Promise<unknown> {
  const dep = c.config.deployment;
  const from = BigInt(dep.deployBlock);
  switch (name) {
    case "get_wallet": {
      const key = w.address ? ((await c.pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [w.address] })) as Hex) : "0x";
      const badge = w.locks.find((l) => !l.unlocked);
      return {
        address: w.address,
        zipped_zc: fmt(c.notes.balance),
        largest_note_zc: fmt(c.notes.largest),
        waiting_to_clear_zc: fmt(c.notes.waiting.reduce((a, n) => a + n.value, 0n)),
        public_wallet_zc: fmt(c.walletZc),
        badge_tier: badge ? badge.tier : 0,
        zip_address_set_up: !/^0x0*$/.test(key),
      };
    }
    case "check_recipient": {
      const a = String(input.address ?? "");
      if (!isAddress(a)) return { valid: false, note: "Not an Ethereum address." };
      const [code, key, cast] = await Promise.all([
        c.pub.getCode({ address: a }),
        c.pub.readContract({ address: dep.addressRegistry, abi: zipAddressRegistryAbi, functionName: "keyOf", args: [a] }) as Promise<Hex>,
        fetch("/api/veridia/cast").then((r) => r.json() as Promise<{ name: string; wallet: string; shop?: string }[]>).catch(() => []),
      ]);
      const shop = shops.find((s) => s.payout.toLowerCase() === a.toLowerCase());
      const resident = cast.find((r) => r.wallet.toLowerCase() === a.toLowerCase());
      return {
        valid: true,
        is_you: w.address?.toLowerCase() === a.toLowerCase(),
        is_contract: !!code && code !== "0x",
        has_zip_address: !/^0x0*$/.test(key),
        merchant: shop ? { id: shop.id.toString(), name: shop.name } : null,
        veridia_resident: resident ? resident.name : null,
      };
    }
    case "list_merchants": {
      const bps = (await c.pub.readContract({ address: dep.pay, abi: zipPayAbi, functionName: "TAX_BPS" })) as bigint;
      return { tax_percent: Number(bps) / 100, merchants: shops.map((s) => ({ id: s.id.toString(), name: s.name })) };
    }
    case "read_inbox": {
      const [knocks, posts, polls, head] = await Promise.all([
        w.address ? c.pub.getLogs({ address: dep.doorstep, event: knocked, args: { door: w.address }, fromBlock: from }) : Promise.resolve([]),
        c.pub.getLogs({ address: dep.signal, event: posted, fromBlock: from }),
        c.pub.getLogs({ address: dep.polls, event: pollCreated, fromBlock: from }),
        c.pub.getBlock(),
      ]);
      const tier = w.locks.find((l) => !l.unlocked)?.tier ?? 0;
      const groups = await Promise.all(Array.from({ length: tier }, (_, i) => c.pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [BigInt(i)] }) as Promise<bigint>));
      return {
        knocks_at_your_door: knocks
          .map((k) => ({ from: k.args.knocker === "0x0000000000000000000000000000000000000000" ? "anonymous" : k.args.knocker, burned_zc: fmt(k.args.burned!), gift_zc: fmt(k.args.gift!), message: k.args.message }))
          .sort((x, y) => Number(y.burned_zc.replace(/,/g, "")) - Number(x.burned_zc.replace(/,/g, "")))
          .slice(0, 10),
        recent_board_posts: posts.slice(-8).reverse().map((p) => p.args.message),
        open_polls_you_can_answer: polls
          .filter((p) => Number(p.args.endsAt) > Number(head.timestamp) && groups.includes(p.args.groupId!))
          .map((p) => ({ poll_id: p.args.pollId!.toString(), question: p.args.question!.split("\n")[0], reward_zc: fmt(p.args.rewardPerVote!) })),
      };
    }
    case "pool_activity": {
      const head = await c.pub.getBlock();
      const span = 300n;
      const past = await c.pub.getBlock({ blockNumber: head.number > span ? head.number - span : 0n });
      const hours = Math.max(1 / 60, (Number(head.timestamp) - Number(past.timestamp)) / 3600);
      const recent = (b: bigint) => b > past.number;
      const deposits = c.pool.state.deposits.filter((d) => recent(d.block)).length;
      const spends = c.pool.state.withdrawals.filter((x) => recent(x.block)).length;
      const perHour = (deposits + spends) / hours;
      return {
        deposits_per_hour: Math.round(deposits / hours),
        spends_per_hour: Math.round(spends / hours),
        notes_ever_zipped: c.pool.state.deposits.length,
        suggested_hold: perHour >= 30 ? "hour" : "epoch",
        why: perHour >= 30 ? "The pool is busy; an hour's delay already mixes you with plenty of others." : "The pool is quiet; holding until the epoch ends puts more activity between you and your action.",
      };
    }
    case "propose_action":
      return { shown: true, note: "The person sees a card and will confirm or dismiss it themselves. Don't say it happened." };
    default:
      return { error: `unknown tool ${name}` };
  }
}

async function execute(p: Proposal, c: Ctx, me: Address | null) {
  const amount = parseEther(p.amount_zc || "0");
  const hold = HOLD[p.hold];
  switch (p.action) {
    case "zip":
      return doZip(c, amount);
    case "send":
      return doSend(c, amount, p.to, hold);
    case "send_link":
      return doSend(c, amount, null, hold);
    case "pay":
      return doPay(c, BigInt(p.merchant_id ?? "0"), amount);
    case "unzip":
      return doUnzip(c, amount, (p.to ?? me ?? "") as Address, hold);
    case "speak":
      return doSpeak(c, amount, p.message ?? "", p.target ?? "", hold);
    case "knock":
      return doKnock(c, (p.to ?? "") as Address, amount, 0n, p.message ?? "");
  }
}

const LABEL: Record<Proposal["action"], string> = { zip: "Zip", send: "Send privately", send_link: "Make a link", pay: "Pay", unzip: "Unzip", speak: "Burn and speak", knock: "Burn at their door" };

export function Emerald() {
  const w = useWallet();
  const ctx = useCtx();
  const shops = useShops();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const ask = async (text: string) => {
    if (!ctx || !text.trim()) return;
    setError(null);
    setThinking(true);
    let history: Msg[] = [...msgs, { role: "user", content: text.trim() }];
    setMsgs(history);
    setInput("");
    try {
      for (let step = 0; step < 8; step++) {
        const res = await fetch("/api/emerald", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history }) });
        const j = (await res.json()) as { content?: Block[]; stop_reason?: string; error?: string };
        if (!res.ok || !j.content) throw new Error(j.error ?? "Emerald couldn't answer.");
        // Append the assistant turn exactly as returned; the history must never be edited
        history = [...history, { role: "assistant", content: j.content }];
        setMsgs(history);
        if (j.stop_reason === "refusal") throw new Error("Emerald can't help with that one.");
        if (j.stop_reason !== "tool_use") break;
        const results: Block[] = [];
        for (const b of j.content) {
          if (b.type !== "tool_use") continue;
          const t = b as { id: string; name: string; input: Record<string, unknown> };
          if (t.name === "propose_action") setProposals((ps) => [...ps, { ...(t.input as Omit<Proposal, "id" | "state">), id: t.id, state: "open" }]);
          let out: unknown;
          try {
            out = await runTool(t.name, t.input, ctx, w, shops);
          } catch (e) {
            out = { error: (e as Error).message.split("\n")[0] };
          }
          results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) });
        }
        history = [...history, { role: "user", content: results }];
        setMsgs(history);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
  };

  const confirm = async (p: Proposal) => {
    if (!ctx) return;
    setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "running" } : x)));
    try {
      const d = await execute(p, ctx, w.address);
      setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "done", result: d.text, link: d.link } : x)));
    } catch (e) {
      setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "failed", result: (e as Error).message.split("\n")[0] } : x)));
    }
  };

  type Item = { key: string; who: "user" | "assistant"; text: string; tool: string | null; proposal: Proposal | null };
  const visible: Item[] = msgs.flatMap((m, i): Item[] => {
    if (typeof m.content === "string") return [{ key: `${i}`, who: m.role, text: m.content, tool: null, proposal: null }];
    return m.content.flatMap((b, k): Item[] => {
      if (b.type === "text" && (b as { text: string }).text.trim()) return [{ key: `${i}-${k}`, who: m.role, text: (b as { text: string }).text, tool: null, proposal: null }];
      if (b.type === "tool_use") {
        const t = b as { id: string; name: string };
        if (t.name === "propose_action") return [{ key: `${i}-${k}`, who: "assistant" as const, text: "", tool: null, proposal: proposals.find((p) => p.id === t.id) ?? null }];
        return [{ key: `${i}-${k}`, who: "assistant" as const, text: "", tool: t.name.replace(/_/g, " "), proposal: null }];
      }
      return [];
    });
  });

  return (
    <div>
      <p className="leading-relaxed">
        Emerald checks an address before you pay, tells you what&apos;s new at your door, and suggests how to time things. It can
        only propose; nothing moves until you confirm. It sees what its tools report about your wallet, never your keys.
      </p>
      <div className="mt-6 space-y-4">
        {visible.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {["What's new at my door?", "Is 0x… a real merchant?", "Send 20 ZC to Seila privately", "When should I unzip to stay private?"].map((s) => (
              <button key={s} onClick={() => setInput(s)} className="rounded-full border border-frost px-3 py-1 text-sm hover:border-pine">
                {s}
              </button>
            ))}
          </div>
        )}
        {visible.map((v) =>
          v.proposal ? (
            <ProposalCard key={v.key} p={v.proposal} shops={shops} onConfirm={confirm} onDismiss={(p) => setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, state: "dismissed" } : x)))} />
          ) : v.tool ? (
            <p key={v.key} className="text-[0.8rem] italic text-lichen">
              Emerald {v.tool === "check recipient" ? "checked the address" : v.tool === "get wallet" ? "looked at your wallet" : v.tool === "read inbox" ? "read your inbox" : v.tool === "pool activity" ? "looked at the pool" : "looked at the merchants"}.
            </p>
          ) : v.who === "user" ? (
            <p key={v.key} className="ml-auto max-w-[85%] rounded-md bg-drift px-3 py-2">
              {v.text}
            </p>
          ) : (
            <p key={v.key} className="max-w-[85%] whitespace-pre-wrap font-story text-lg leading-relaxed">
              {v.text}
            </p>
          ),
        )}
        {thinking && <p className="font-story italic text-lichen">Emerald is thinking…</p>}
        {error && <p className="rounded-md bg-candle/15 px-3 py-2 text-sm">{error}</p>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="mt-6 flex gap-2"
      >
        <input className={inputCls} placeholder="Ask Emerald" value={input} onChange={(e) => setInput(e.target.value)} disabled={thinking} aria-label="Ask Emerald" />
        <Button type="submit" busy={thinking} disabled={!input.trim()}>
          Ask
        </Button>
      </form>
    </div>
  );
}

function ProposalCard({ p, shops, onConfirm, onDismiss }: { p: Proposal; shops: Shop[]; onConfirm: (p: Proposal) => void; onDismiss: (p: Proposal) => void }) {
  const shop = p.merchant_id ? shops.find((s) => s.id.toString() === p.merchant_id) : null;
  const rows: [string, string][] = [
    ["Amount", `${p.amount_zc} ZC${p.action === "pay" ? " + sales tax" : ""}`],
    ...(p.to ? ([["To", p.to]] as [string, string][]) : []),
    ...(shop ? ([["Merchant", shop.name]] as [string, string][]) : []),
    ...(p.message ? ([["Message", p.message]] as [string, string][]) : []),
    ...(p.target ? ([["For", p.target]] as [string, string][]) : []),
    ...(["send", "send_link", "unzip", "speak"].includes(p.action) ? ([["Courier sends it", p.hold === "now" ? "now" : p.hold === "hour" ? "within the hour" : "any time this epoch"]] as [string, string][]) : []),
  ];
  return (
    <div className={clsx("rounded-md border px-4 py-3", p.state === "done" ? "border-pad" : p.state === "failed" ? "border-candle" : "border-frost")}>
      <p className="font-story text-lg">{LABEL[p.action]}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-lichen">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-sm text-lichen">{p.reason}</p>
      {p.state === "open" && (
        <div className="mt-3 flex gap-2">
          <Button tone={p.action === "speak" || p.action === "knock" ? "candle" : "pad"} onClick={() => onConfirm(p)}>
            Confirm
          </Button>
          <Button tone="quiet" onClick={() => onDismiss(p)}>
            Dismiss
          </Button>
        </div>
      )}
      {p.state === "running" && <p className="mt-3 text-sm">Working…</p>}
      {p.state === "dismissed" && <p className="mt-3 text-sm text-lichen">Dismissed.</p>}
      {p.result && <p className="mt-3 text-sm">{p.result}</p>}
      {p.link && (
        <p className="mt-2 break-all text-sm font-medium">
          <a href={p.link} className="underline underline-offset-2">
            {p.link}
          </a>
        </p>
      )}
    </div>
  );
}
