/**
 * Veridia: *Snowmoon*'s people, living on zipcoin.
 *
 * An orchestrator wakes a random resident at Poisson-distributed times (ACTIONS_PER_HOUR); their mind picks one
 * everyday action and a line of narration; deterministic code executes it through a courier, which holds the proof
 * for a random while. The result is steady real traffic in the same job kinds real users send (pays, rezips, knocks,
 * anonymous polls and answers, messages), and a
 * public story about it. The story is told late and loosely (story.ts): each event after its own random delay, with
 * no job ids, hashes, amounts, shops, items or exact times, so it can't be lined up with the chain and residents'
 * spends stay in the crowd real users hide in. Pool and app actions only, never swaps. Disclosed as a simulation. A
 * daily gas cap (VERIDIA_DAILY_GAS_WEI) bounds what it spends.
 *
 *   GET /feed?since=<ms>    the told story (coarsened, delayed)
 *   GET /cast               residents: names, cities, bios, shops. No wallets or zip addresses.
 *
 * What an observer can still link, honestly:
 *   - Residents' wallets as a group: each is funded with gas (and a little ZC) by the treasury, and makes public calls
 *     (zip-address registration, badge lock, shop registration, public polls, and a resident's own occasional "zip"
 *     deposit). The story can tie a name to a wallet by those public acts.
 *   - The treasury's deposits of residents' savings are Veridia's (not whose). A cast bootstrapped before this change
 *     deposited from its own wallets, and those deposits stay attributable to each resident.
 *   - Spends whose destination is Veridia's own: payments at Veridia shops (merchant names start "veridia:"), knocks
 *     and messages at resident wallets, and answers in polls residents created. These are probably a resident's, though not which note paid.
 *   - Counts: the story says roughly how many of each kind of thing residents did in a part of the day, so an observer
 *     learns how many other (user) spends of that kind happened then, not which ones.
 * What it can't link: which deposit any spend came from; which private send (rezip), anonymous post or open broadcast is
 * a resident's rather than a user's; and any told event to its transaction, job or exact time.
 */
import http from "node:http";
import { formatEther, parseEther } from "viem";

import {
  allowance,
  burnFloor,
  askAnon,
  bootstrap,
  createPoll,
  eat,
  knock,
  message,
  openPolls,
  post,
  refresh,
  Skip,
  speak,
  vote,
  walletZc,
  zip,
  zipped,
  type Outcome,
} from "./act";
import { OverBudget } from "./budget";
import { byId, CAST, type Character } from "./cast";
import { decide, idle, type Intent, type Situation } from "./mind";
import { budget, cfg, facts, people, record, story } from "./world";

const zcOf = (x: number | undefined, lo: number, hi: number, dflt: number) => parseEther(String(Math.max(lo, Math.min(Math.floor(x ?? dflt), hi))));
const big = (s: string | undefined) => {
  if (!s || !/^\d+$/.test(s.replace(/^#/, ""))) throw new Skip("no such id");
  return BigInt(s.replace(/^#/, ""));
};
const options = (o: string[] | undefined) => {
  const xs = (o ?? []).map((x) => x.trim().slice(0, 80)).filter(Boolean);
  if (xs.length < 2) throw new Skip("needs a question and at least two options");
  return xs.slice(0, 6);
};
const resident = (id: string | undefined) => {
  if (!id || !byId.has(id)) throw new Skip("nobody by that name");
  return id;
};

async function act(c: Character, i: Intent): Promise<Outcome | null> {
  switch (i.action) {
    case "eat":
      return eat(c, byId.has(i.target ?? "") && byId.get(i.target!)!.shop ? i.target! : "kalimar-kitchen", i.item ?? "");
    case "allowance":
      return allowance(c, resident(i.target), zcOf(i.amount, 1, 500, 10));
    case "knock":
      return knock(c, resident(i.target), i.message ?? "");
    case "speak":
      return speak(c, i.message ?? i.line, i.audience ?? "");
    case "message":
      return message(c, resident(i.target), i.message ?? i.line);
    case "post":
      return post(c, i.message ?? i.line);
    case "poll":
      if (!i.message) throw new Skip("a poll needs a question");
      return createPoll(c, i.message, options(i.options));
    case "ask":
      if (!i.message) throw new Skip("a poll needs a question");
      return askAnon(c, i.message, options(i.options));
    case "vote":
      return vote(c, big(i.pollId), i.option ?? 0);
    case "zip":
      return zip(c, parseEther(String(Math.max(1, Math.floor(i.amount ?? 10)))));
    case "rest":
      return null;
  }
}

async function situation(c: Character): Promise<Situation> {
  const who = people.get(c.id)!;
  const polls = await openPolls();
  const floor = Math.ceil(Number(formatEther(await burnFloor())));
  const prices: Record<string, number> = Object.fromEntries(c.close.map((id) => [id, floor]));
  return {
    zippedZc: Number(formatEther(zipped(who).balance)),
    walletZc: Number(formatEther(await walletZc(who))),
    badge: facts.badged.includes(c.id),
    // Each resident answers a poll once; only offer the ones they haven't answered
    openPolls: polls
      .filter((p) => !facts.voted[c.id]?.includes(p.pollId.toString()))
      .map((p) => ({ pollId: p.pollId.toString(), question: p.question, optionCount: p.optionCount })),
    prices,
  };
}

let capNoticeDay = -1;

async function turn() {
  const c = CAST[Math.floor(Math.random() * CAST.length)];

  // Out of gas money for today: a line that touches no chain and calls no model, until the next UTC day
  if (budget.exhausted()) {
    const day = Math.floor(Date.now() / 86_400_000);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      console.log(`[veridia] daily gas budget spent; scripted lines only for the next ${Math.ceil(budget.msToReset() / 60_000)} min`);
    }
    const i = idle(c);
    record({ who: c.id, action: "rest", line: i.line, detail: { mind: "script", budget: "spent" } });
    return;
  }

  await refresh();

  const { intent, by } = await decide(c, await situation(c));
  try {
    const out = await act(c, intent);
    record({ who: c.id, action: intent.action, line: intent.line, detail: { ...out?.detail, mind: by }, tx: out?.tx, job: out?.job });
  } catch (e) {
    if (!(e instanceof Skip) && !(e instanceof OverBudget)) console.error(`[veridia] ${c.id} ${intent.action} failed:`, (e as Error).message.split("\n")[0]);
    record({ who: c.id, action: "rest", line: `${c.name} thinks better of it and stays home.`, detail: { wanted: intent.action, why: (e as Error).message.split("\n")[0], mind: by } });
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body: unknown = { error: "not found" };
    if (url.pathname === "/feed") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = story.feed(Number.isFinite(since) ? since : 0);
    } else if (url.pathname === "/cast") {
      // Residents' wallets and zip addresses are deliberately not listed: their spends are meant to look like anyone's
      body = CAST.map((c) => ({ id: c.id, name: c.name, city: c.city, bio: c.bio, shop: c.shop?.name }));
    }
    res.writeHead(body && !(body as { error?: string }).error ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  })
  .listen(cfg.port, () => console.log(`[veridia] feed on :${cfg.port}`));

// The story catches up with the world a little at a time: each event is told once its own delay has passed
setInterval(() => story.flush(), 30_000);
story.flush();

await bootstrap();
console.log(
  `[veridia] ${CAST.length} residents awake, ~${cfg.actionsPerHour} actions/hour, ` +
    `gas budget ${cfg.dailyGasWei ? `${formatEther(cfg.dailyGasWei)} ETH/day (${formatEther(budget.spent())} spent today)` : "uncapped"}, ` +
    `mind: ${cfg.useLlm !== "off" && process.env.DEEPSEEK_API_KEY ? `DeepSeek ${cfg.model}` : "scripted"}`,
);
const next = () => setTimeout(async () => {
  try {
    await turn();
  } catch (e) {
    console.error("[veridia]", (e as Error).message.split("\n")[0]);
  }
  next();
}, (-Math.log(1 - Math.random()) * 3_600_000) / cfg.actionsPerHour);
next();
