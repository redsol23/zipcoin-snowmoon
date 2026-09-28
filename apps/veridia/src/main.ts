/**
 * Veridia: *Snowmoon*'s people, living on zipcoin.
 *
 * An orchestrator wakes a random resident at Poisson-distributed times; their mind picks one everyday action and a
 * line of narration; deterministic code executes it through a courier, which holds the proof for a random while.
 * The result is a public story feed and, underneath it, steady real pool traffic: the cover that makes every real
 * user's zip, send and pay unlinkable. Pool actions only, never swaps. Disclosed as a simulation.
 *
 *   GET /feed?since=<ms>    world events (the story)
 *   GET /cast               residents, their public wallets and zip addresses
 */
import http from "node:http";
import { formatEther, parseEther } from "viem";

import { allowance, bootstrap, createPoll, eat, knock, openPolls, post, refresh, Skip, speak, vote, walletZc, zip, zipped, type Outcome } from "./act";
import { byId, CAST, type Character } from "./cast";
import { decide, type Intent } from "./mind";
import { cfg, events, people, record } from "./world";

async function act(c: Character, i: Intent): Promise<Outcome | null> {
  switch (i.action) {
    case "eat":
      return eat(c, byId.has(i.target ?? "") && byId.get(i.target!)!.shop ? i.target! : "kalimar-kitchen", i.item ?? "");
    case "allowance":
      if (!i.target || !byId.has(i.target)) throw new Skip("unknown recipient");
      return allowance(c, i.target, parseEther(String(Math.max(1, Math.min(i.amount ?? 10, 500)))));
    case "knock":
      if (!i.target || !byId.has(i.target)) throw new Skip("unknown door");
      return knock(c, i.target, i.message ?? "");
    case "speak":
      return speak(c, i.message ?? i.line, i.audience ?? "");
    case "post":
      return post(c, i.message ?? i.line);
    case "poll":
      if (!i.message || !i.options || i.options.length < 2) throw new Skip("a poll needs a question and options");
      return createPoll(c, i.message, i.options.slice(0, 6));
    case "vote":
      return vote(c, BigInt(i.pollId ?? "0"), i.option ?? 0);
    case "zip":
      return zip(c, parseEther(String(Math.max(1, Math.floor(i.amount ?? 10)))));
    case "rest":
      return null;
  }
}

async function turn() {
  const c = CAST[Math.floor(Math.random() * CAST.length)];
  const who = people.get(c.id)!;
  await refresh();
  const situation = {
    zippedZc: Number(formatEther(zipped(who).balance)),
    walletZc: Number(formatEther(await walletZc(who))),
    openPolls: (await openPolls()).map((p) => ({ pollId: p.pollId.toString(), question: p.question, optionCount: p.optionCount })),
  };
  const { intent, by } = await decide(c, situation);
  try {
    const out = await act(c, intent);
    record({ who: c.id, action: intent.action, line: intent.line, detail: { ...out?.detail, mind: by }, tx: out?.tx, job: out?.job });
  } catch (e) {
    if (!(e instanceof Skip)) console.error(`[veridia] ${c.id} ${intent.action} failed:`, (e as Error).message.split("\n")[0]);
    record({ who: c.id, action: "rest", line: `${c.name} thinks better of it and stays home.`, detail: { wanted: intent.action, why: (e as Error).message.split("\n")[0], mind: by } });
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body: unknown = { error: "not found" };
    if (url.pathname === "/feed") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = events.filter((e) => e.at > since).slice(-200);
    } else if (url.pathname === "/cast") {
      body = CAST.map((c) => ({ id: c.id, name: c.name, city: c.city, bio: c.bio, shop: c.shop?.name, wallet: people.get(c.id)!.account.address, zipAddress: people.get(c.id)!.zipAddress.publicKey }));
    }
    res.writeHead(body && !(body as { error?: string }).error ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  })
  .listen(cfg.port, () => console.log(`[veridia] feed on :${cfg.port}`));

await bootstrap();
console.log(`[veridia] ${CAST.length} residents awake, ~${cfg.actionsPerHour} actions/hour`);
const next = () => setTimeout(async () => {
  try {
    await turn();
  } catch (e) {
    console.error("[veridia]", (e as Error).message.split("\n")[0]);
  }
  next();
}, (-Math.log(1 - Math.random()) * 3_600_000) / cfg.actionsPerHour);
next();
