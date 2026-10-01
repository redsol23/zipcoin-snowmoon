"use client";

import {
  badgeReturnSecrets,
  badgeRewardAccount,
  encodeLock,
  encodePollCreation,
  groupMembers,
  hashPrecommitment,
  memberSiblings,
  pendingEth,
  toJson,
  zipBadgesAbi,
} from "@zipnet/sdk";
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";
import { formatEther, isAddress, parseAbiItem, zeroAddress, type Address } from "viem";

import { answerPoll, postToBoard } from "@/lib/anon";
import { pollRewardAddress } from "@/lib/poll-rewards";
import { courierQuote, pickNote, spend, type Config } from "@/lib/wallet";

import { Button, checkJob, errorText, Field, inputCls, Result, toWei, zc, type Outcome } from "./ui";
import { useWallet } from "./WalletProvider";

// ---------------------------------------------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------------------------------------------

type Tiers = { thresholds: bigint[]; groups: bigint[] };

function useTiers() {
  const w = useWallet();
  const [tiers, setTiers] = useState<Tiers | null>(null);
  useEffect(() => {
    if (!w.config || !w.pub) return;
    const { badges } = w.config.deployment;
    const pub = w.pub;
    (async () => {
      const n = Number(await pub.readContract({ address: badges, abi: zipBadgesAbi, functionName: "tierCount" }));
      const idx = Array.from({ length: n }, (_, i) => BigInt(i));
      const thresholds = (await Promise.all(idx.map((i) => pub.readContract({ address: badges, abi: zipBadgesAbi, functionName: "thresholds", args: [i] })))) as bigint[];
      const groups = (await Promise.all(idx.map((i) => pub.readContract({ address: badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [i] })))) as bigint[];
      setTiers({ thresholds, groups });
    })();
  }, [w.config, w.pub]);
  return tiers;
}

/** Posts and votes carry no fee, so they go to the courier as plain jobs. */
async function freeJob(c: Config, kind: "post" | "vote" | "unlock" | "claimEth", args: unknown[], holdSec = 0) {
  const res = await fetch(`${c.courierUrl}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ kind, args, holdSec }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  return checkJob(j as { id: string; status: string; tx?: string });
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
      setOut({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, out, run };
}

type Lock = ReturnType<typeof useWallet>["locks"][number];
/** The live badge lock with the highest tier (a key may hold several, one identity each, A-7) */
const activeTier = (locks: Lock[]) => locks.filter((l) => !l.unlocked).sort((a, b) => b.tier - a.tier)[0] ?? null;
const DAY = 86_400;

// ---------------------------------------------------------------------------------------------------------------
// badges
// ---------------------------------------------------------------------------------------------------------------

export function Badges() {
  const w = useWallet();
  const tiers = useTiers();
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("30");
  const { busy, out, run } = useRun();
  // The contract checks block time, not this browser's clock
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    w.pub?.getBlock().then((b) => setNow(Number(b.timestamp)));
  }, [w.pub, w.pool]);
  const active = activeTier(w.locks);
  const v = toWei(amount);
  const d = Math.floor(Number(days) || 0);
  const weight = v ? v * BigInt(d) : 0n;
  const tier = tiers ? tiers.thresholds.filter((t) => weight >= t).length : 0;

  const lock = () =>
    run(async () => {
      if (!w.config || !w.zip || !w.pool || !w.notes || !v) throw new Error("Enter an amount.");
      if (d < 7 || d > 730) throw new Error("Lock for 7 to 730 days.");
      if (tier === 0) throw new Error("That lock is too small for a badge. Lock more, or for longer.");
      const q = await courierQuote(w.config);
      const r = badgeReturnSecrets(w.zip.keys, BigInt(w.locks.length));
      const data = encodeLock({
        identityCommitment: w.zip.nextLockIdentity.commitment, // a fresh identity per lock (A-7)
        duration: BigInt(d * DAY),
        returnPrecommitment: hashPrecommitment(r.nullifier, r.secret),
        courier: { feeRecipient: q.courier, fee: q.fee("lock") },
        rewardTo: badgeRewardAccount(w.zip.keys, BigInt(w.locks.length)).address, // one reward address per lock (I-3)
      });
      const note = pickNote(w.notes.spendable, v + q.fee("lock"));
      if (!note) throw new Error(`Your largest cleared note holds ${zc(w.notes.largest)} ZC.`);
      checkJob(await spend(w.config, w.zip.keys, w.pool, note, v + q.fee("lock"), "lock", w.config.deployment.badges, data, 0));
      setTimeout(w.refresh, 3000);
      return { tone: "ok", text: `Locked ${zc(v)} ZC from a zipped note for ${d} days. You hold a tier ${tier} badge, and nobody can tell which wallet is behind it.` };
    });

  const live = w.locks.filter((l) => !l.unlocked).sort((a, b) => b.tier - a.tier);
  const unlock = (lock: Lock) =>
    run(async () => {
      if (!w.config || !w.pub || !w.zip) throw new Error("Nothing to unlock.");
      const siblings: bigint[][] = [];
      for (let i = 0; i < lock.tier; i++) {
        siblings.push(memberSiblings(await groupMembers(w.pub, w.config.deployment.semaphore, tiers!.groups[i], BigInt(w.config.deployment.deployBlock)), lock.identityCommitment));
      }
      await freeJob(w.config, "unlock", [lock.lockId, siblings]);
      setTimeout(w.refresh, 3000);
      return { tone: "ok", text: `${zc(lock.value)} ZC goes back into the pool as a note only your key can spend. That badge is gone.` };
    });

  return (
    <div className="space-y-6">
      <p className="leading-relaxed">
        Lock zipcoins for a while to earn a badge. A badge lets you post and answer polls as &ldquo;someone with tier N&rdquo;, the
        way the book&apos;s messages read &ldquo;Anonymous · Rep score ≥ 200 · Verified ✓&rdquo;. The lock comes from a zipped note,
        so no wallet is attached to it, and when it ends the coins return to your zip key.
      </p>
      {tiers && (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {tiers.thresholds.map((t, i) => (
            <div key={i} className={clsx("rounded-md border px-3 py-2", active && active.tier > i ? "border-pad" : "border-frost")}>
              <dt className="font-story text-lg">Tier {i + 1}</dt>
              <dd className="text-[0.8rem] text-lichen">{zc(t)} ZC-days</dd>
            </div>
          ))}
        </dl>
      )}
      {live.map((l) => (
        <div key={l.lockId.toString()} className="space-y-3">
          <p>
            You hold a <strong>tier {l.tier}</strong> badge: {zc(l.value)} ZC locked until{" "}
            {new Date(l.unlockAt * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
          </p>
          {l.unlockAt <= now ? (
            <Button tone="pad" busy={busy} onClick={() => unlock(l)}>
              Unlock and take the coins back
            </Button>
          ) : (
            <p className="text-sm text-lichen">You can unlock once the time is up.</p>
          )}
        </div>
      ))}
      {live.length > 0 && <p className="text-sm text-lichen">Each badge has its own identity, so your badges can&apos;t be linked to each other. You can add another one below.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lock();
        }}
        className="max-w-lg space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount">
            <input className={inputCls} inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Days">
            <input className={inputCls} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <p className="text-sm text-lichen">{v && (d < 7 || d > 730) ? "Lock for 7 to 730 days." : v ? (tier ? `This earns tier ${tier}.` : "Not enough for tier 1 yet.") : "Weight is amount × days."}</p>
        <Button type="submit" tone="pad" busy={busy} disabled={!v || !tier}>
          Lock and earn the badge
        </Button>
      </form>
      <BadgeEth />
      <Result out={out} />
    </div>
  );
}

/**
 * ETH that locked ZC earns (ZC pays its holders ETH). It goes to addresses derived from the zip key, not the wallet, so
 * the badges stay unlinked: one per lock for new locks (I-3), and the one-per-key address older locks named. A courier
 * pays each out because those addresses have no gas of their own. Each is claimed on its own, so a courier isn't
 * handed several of them at once (which would link those locks).
 */
function BadgeEth() {
  const w = useWallet();
  const { busy, out, run } = useRun();
  const [rows, setRows] = useState<{ account: Address; pending: bigint; held: bigint }[]>([]);
  const keys = w.zip?.keys;
  const count = w.locks.length;
  const load = useCallback(async () => {
    if (!w.config || !w.pub || !keys) return;
    const accounts = [badgeRewardAccount(keys).address, ...Array.from({ length: count }, (_, i) => badgeRewardAccount(keys, BigInt(i)).address)];
    const all = await Promise.all(
      accounts.map(async (account) => {
        const [pending, held] = await Promise.all([pendingEth(w.pub!, w.config!.deployment, "badges", account), w.pub!.getBalance({ address: account })]);
        return { account, pending, held };
      }),
    );
    setRows(all.filter((r) => r.pending > 0n || r.held > 0n));
  }, [w.config, w.pub, keys, count]);
  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load, w.pool]);
  if (!rows.length) return null;

  const claim = (account: Address) =>
    run(async () => {
      if (!w.config) throw new Error("Not connected.");
      await freeJob(w.config, "claimEth", [account]);
      setTimeout(load, 3000);
      return { tone: "ok", text: `Sent to ${account}, a reward address only your zip key controls.` };
    });

  return (
    <div className="space-y-1 text-sm">
      {rows.map((r) => (
        <div key={r.account}>
          <p>
            ETH rewards at {r.account.slice(0, 8)}…: {formatEther(r.pending)} ETH{" "}
            {r.pending > 0n && (
              <>
                &mdash;{" "}
                <Button tone="quiet" busy={busy} onClick={() => claim(r.account)}>
                  Claim
                </Button>
              </>
            )}
          </p>
          {r.held > 0n && <p className="text-lichen">{formatEther(r.held)} ETH claimed so far, held there. Spending it from there links it to wherever it goes.</p>}
        </div>
      ))}
      <Result out={out} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// board: anonymous posts by badge tier
// ---------------------------------------------------------------------------------------------------------------

type Post = { groupId: bigint; message: string; block: bigint };
const posted = parseAbiItem("event Posted(uint256 indexed groupId, uint256 indexed day, uint256 nullifier, string message)");

export function Board() {
  const w = useWallet();
  const tiers = useTiers();
  const [posts, setPosts] = useState<Post[]>([]);
  const [text, setText] = useState("");
  const [tierIdx, setTierIdx] = useState(0);
  const { busy, out, run } = useRun();
  const active = activeTier(w.locks);

  const load = useCallback(async () => {
    if (!w.config || !w.pub) return;
    const logs = await w.pub.getLogs({ address: w.config.deployment.signal, event: posted, fromBlock: BigInt(w.config.deployment.deployBlock) });
    setPosts(logs.map((l) => ({ groupId: l.args.groupId!, message: l.args.message!, block: l.blockNumber })).reverse());
  }, [w.config, w.pub]);
  useEffect(() => {
    load();
  }, [load, w.pool]);

  const tierOf = (g: bigint) => (tiers ? tiers.groups.findIndex((x) => x === g) + 1 : 0);

  const post = () =>
    run(async () => {
      if (!w.config || !w.pub || !w.zip || !tiers || !active) throw new Error("You need a badge to post here.");
      if (!text.trim()) throw new Error("Write something first.");
      // Five posts per badge per day; the free slot is picked locally, and only its proof is sent (A-3)
      await postToBoard({ config: w.config, pub: w.pub, provers: w.zip.provers }, tiers.groups[tierIdx], text);
      setText("");
      setTimeout(load, 3000);
      return { tone: "ok", text: `Posted as a tier ${tierIdx + 1} badge holder. The proof shows you hold the badge, not which holder you are.` };
    });

  return (
    <div className="space-y-6">
      {active ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
          className="max-w-lg space-y-4"
        >
          <Field label="Post as" hint="A lower tier hides you among more people.">
            <select className={inputCls} value={tierIdx} onChange={(e) => setTierIdx(Number(e.target.value))}>
              {Array.from({ length: active.tier }, (_, i) => (
                <option key={i} value={i}>
                  Some tier {i + 1} holder
                </option>
              ))}
            </select>
          </Field>
          <Field label="Message" hint={`${text.length}/560`}>
            <textarea className={clsx(inputCls, "min-h-24")} maxLength={560} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Button type="submit" busy={busy} disabled={!text.trim()}>
            Post anonymously
          </Button>
        </form>
      ) : (
        <p className="text-sm text-lichen">Earn a badge on the Badges tab to post here. Anyone can read.</p>
      )}
      <Result out={out} />
      <ul className="divide-y divide-frost/70">
        {posts.length === 0 && <li className="py-3 font-story italic text-lichen">No posts yet.</li>}
        {posts.map((p, i) => (
          <li key={i} className="py-3">
            <p className="font-story text-lg leading-relaxed">{p.message}</p>
            <p className="mt-1 text-[0.8rem] text-lichen">Anonymous · tier {tierOf(p.groupId) || "?"} badge · verified</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// polls
// ---------------------------------------------------------------------------------------------------------------

type Poll = { id: bigint; groupId: bigint; burned: bigint; reward: bigint; maxVotes: bigint; endsAt: number; question: string; options: string[]; tally: number[] };
const pollCreated = parseAbiItem(
  "event PollCreated(uint256 indexed pollId, uint256 indexed groupId, address indexed creator, uint256 burned, uint256 rewardPerVote, uint256 maxVotes, uint64 endsAt, uint8 optionCount, string question)",
);
const voted = parseAbiItem("event Voted(uint256 indexed pollId, uint8 option, uint256 nullifier, address rewardTo, uint256 reward)");

/** Questions store their options as trailing "n. option" lines, the way the residents write them. */
function splitQuestion(q: string, n: number) {
  const lines = q.split("\n");
  const opts = lines.slice(1).map((l) => l.replace(/^\d+\.\s*/, ""));
  return { question: lines[0], options: opts.length === n ? opts : Array.from({ length: n }, (_, i) => opts[i] ?? `Option ${i + 1}`) };
}

export function Polls() {
  const w = useWallet();
  const tiers = useTiers();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [rewardTo, setRewardTo] = useState("");
  const [asking, setAsking] = useState(false);
  const { busy, out, run } = useRun();
  const active = activeTier(w.locks);

  const load = useCallback(async () => {
    if (!w.config || !w.pub) return;
    const from = BigInt(w.config.deployment.deployBlock);
    const [created, votes] = await Promise.all([
      w.pub.getLogs({ address: w.config.deployment.polls, event: pollCreated, fromBlock: from }),
      w.pub.getLogs({ address: w.config.deployment.polls, event: voted, fromBlock: from }),
    ]);
    setPolls(
      created
        .map((l) => {
          const n = Number(l.args.optionCount);
          const { question, options } = splitQuestion(l.args.question!, n);
          const tally = Array(n).fill(0);
          for (const v of votes) if (v.args.pollId === l.args.pollId) tally[Number(v.args.option)]++;
          return { id: l.args.pollId!, groupId: l.args.groupId!, burned: l.args.burned!, reward: l.args.rewardPerVote!, maxVotes: l.args.maxVotes!, endsAt: Number(l.args.endsAt), question, options, tally };
        })
        .reverse(),
    );
  }, [w.config, w.pub]);
  useEffect(() => {
    load();
  }, [load, w.pool]);

  const vote = (p: Poll, option: number) =>
    run(async () => {
      if (!w.config || !w.pub || !w.zip) throw new Error("Unlock your zip key first.");
      // The reward address is public next to the answer (ZipPolls.Voted), so it is never the wallet by default (A-4):
      // an unrewarded poll names no address at all, a rewarded one pays a fresh address derived from the zip key for
      // this poll alone, unless another address is entered.
      const to = (rewardTo || (p.reward === 0n ? zeroAddress : pollRewardAddress(w.zip.phrase, p.id))) as Address;
      if (!isAddress(to)) throw new Error("That reward address isn't valid.");
      // Scope and message are computed here from the poll id, option and address (A-9), not read from the RPC
      await answerPoll({ config: w.config, pub: w.pub, provers: w.zip.provers }, p, option, to, [w.address]);
      setTimeout(load, 3000);
      return {
        tone: "ok",
        text: `Answered "${p.options[option]}". ${p.reward && to !== zeroAddress ? `${zc(p.reward)} ZC goes to ${to.slice(0, 8)}… (${rewardTo ? "the address you entered" : "a fresh address only your zip key controls"}) if the rewards haven't run out.` : ""}`,
      };
    });

  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button tone="quiet" onClick={() => setAsking((a) => !a)}>
          {asking ? "Close" : "Ask a question"}
        </Button>
        <Field label="" hint="Rewards go to a fresh address per poll that only your zip key controls, never your wallet. It is public next to your answer, so only enter one you never use elsewhere.">
          <input className={clsx(inputCls, "max-w-md")} placeholder="Reward to a fresh address (default)" value={rewardTo} onChange={(e) => setRewardTo(e.target.value.trim())} />
        </Field>
      </div>
      {asking && tiers && <AskForm tiers={tiers} onDone={load} />}
      <Result out={out} />
      {polls.length === 0 && <p className="font-story italic text-lichen">No polls yet. Ask the first question.</p>}
      <ul className="space-y-8">
        {polls.map((p) => {
          const open = p.endsAt > now;
          const total = p.tally.reduce((a, b) => a + b, 0);
          const tier = tiers ? tiers.groups.findIndex((g) => g === p.groupId) + 1 : 0;
          const canVote = open && active && tier > 0 && active.tier >= tier;
          return (
            <li key={p.id.toString()}>
              <p className="font-story text-xl leading-snug">{p.question}</p>
              <p className="mt-1 text-[0.8rem] text-lichen">
                {tier ? `Asks tier ${tier} badge holders` : "Asks a merchant's customers"} · {zc(p.burned)} ZC burned to ask ·{" "}
                {open ? `open until ${new Date(p.endsAt * 1000).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}` : "closed"} ·{" "}
                {total} {total === 1 ? "answer" : "answers"}
              </p>
              <ul className="mt-3 space-y-2">
                {p.options.map((o, i) => {
                  const pct = total ? Math.round((p.tally[i] / total) * 100) : 0;
                  return (
                    <li key={i} className="grid grid-cols-[1fr_auto] items-center gap-3">
                      <div className="relative overflow-hidden rounded-md bg-drift px-3 py-1.5">
                        <div className="absolute inset-y-0 left-0 bg-slate/20" style={{ width: `${pct}%` }} aria-hidden />
                        <span className="relative">{o}</span>
                        <span className="relative float-right tabular-nums text-lichen">{p.tally[i]}</span>
                      </div>
                      {canVote && (
                        <Button tone="quiet" busy={busy} onClick={() => vote(p, i)}>
                          Answer
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AskForm({ tiers, onDone }: { tiers: Tiers; onDone: () => void }) {
  const w = useWallet();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("Yes\nNo");
  const [tier, setTier] = useState(0);
  const [burn, setBurn] = useState("200");
  const [reward, setReward] = useState("5");
  const [maxVotes, setMaxVotes] = useState("20");
  const [hours, setHours] = useState("24");
  const { busy, out, run } = useRun();
  const opts = options.split("\n").map((o) => o.trim()).filter(Boolean);
  const b = toWei(burn) ?? 0n;
  const r = toWei(reward) ?? 0n;
  const m = BigInt(Math.max(0, Math.floor(Number(maxVotes) || 0)));
  const total = b + r * m;

  const ask = () =>
    run(async () => {
      if (!w.config || !w.zip || !w.pool || !w.notes) throw new Error("Unlock your zip key first.");
      if (!question.trim() || opts.length < 2 || opts.length > 16) throw new Error("Write a question and 2 to 16 options.");
      const q = await courierQuote(w.config);
      const text = `${question.trim()}\n${opts.map((o, i) => `${i}. ${o}`).join("\n")}`;
      const data = encodePollCreation({
        groupId: tiers.groups[tier],
        question: text,
        optionCount: opts.length,
        duration: BigInt(Math.max(1, Math.floor(Number(hours) || 1)) * 3600),
        burn: b,
        rewardPerVote: r,
        maxVotes: m,
        courier: { feeRecipient: q.courier, fee: q.fee("poll") },
      });
      const note = pickNote(w.notes.spendable, total + q.fee("poll"));
      if (!note) throw new Error(`This poll needs ${zc(total)} ZC in one note; your largest holds ${zc(w.notes.largest)}.`);
      checkJob(await spend(w.config, w.zip.keys, w.pool, note, total + q.fee("poll"), "poll", w.config.deployment.polls, data, 0));
      setTimeout(onDone, 3000);
      return { tone: "ok", text: `Asked, anonymously. ${zc(b)} ZC burned so people take it seriously; up to ${m} answers get ${zc(r)} ZC each. Unused rewards burn when it closes.` };
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        ask();
      }}
      className="max-w-lg space-y-4 rounded-md border border-frost p-4"
    >
      <Field label="Question">
        <input className={inputCls} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </Field>
      <Field label="Options" hint="One per line, 2 to 16.">
        <textarea className={clsx(inputCls, "min-h-20")} value={options} onChange={(e) => setOptions(e.target.value)} />
      </Field>
      <Field label="Who answers">
        <select className={inputCls} value={tier} onChange={(e) => setTier(Number(e.target.value))}>
          {tiers.groups.map((_, i) => (
            <option key={i} value={i}>
              Tier {i + 1} badge holders and up
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Burn to ask" hint="How seriously it should be taken.">
          <input className={inputCls} inputMode="decimal" value={burn} onChange={(e) => setBurn(e.target.value)} />
        </Field>
        <Field label="Open for (hours)">
          <input className={inputCls} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="Reward per answer">
          <input className={inputCls} inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} />
        </Field>
        <Field label="Answers paid">
          <input className={inputCls} inputMode="numeric" value={maxVotes} onChange={(e) => setMaxVotes(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" tone="candle" busy={busy}>
        Ask for {zc(total)} ZC
      </Button>
      <Result out={out} />
    </form>
  );
}
