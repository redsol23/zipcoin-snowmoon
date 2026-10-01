import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CAST } from "./cast";
import { coarsen, delayMs, Story, timeOfDay, type Happened, type Told } from "./story";

const names = new Map(CAST.map((c) => [c.id, c.name]));
const H = 3_600_000;
const MIN = 60_000;
const DAY0 = Date.UTC(2026, 8, 28);

/** A seeded RNG (mulberry32), so every delay and phrasing is reproducible */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const JOB = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d";
const TX = `0x${"9f1c".repeat(16)}`;

/** What the world records today, with every detail the audit worried about */
const sample = (at: number): Happened[] => [
  { at, who: "gladias", action: "eat", line: "Gladias orders the salad at Kalimar Kitchen: 10.5 zc.", detail: { shop: "Kalimar Kitchen", item: "salad", base: "10.5", tax: "0.1" }, job: JOB },
  { at: at + 1, who: "seila", action: "allowance", line: "Seila zips 25 ZC to Febric.", detail: { to: "Febric", amount: "25" }, job: JOB },
  { at: at + 2, who: "mov", action: "knock", line: "Mov burns 140 at Seila's door.", detail: { door: "Seila", burned: "140" }, job: JOB },
  { at: at + 3, who: "zei", action: "post", line: 'Zei posts: "Number Ten is back"', detail: { groupId: "7", anonymous: true }, job: JOB },
  { at: at + 4, who: "evelor", action: "poll", line: 'Evelor asks: "Snow day?"', detail: { question: "Snow day?", options: ["yes", "no"], burned: "200" }, tx: TX },
  { at: at + 5, who: "hreda", action: "zip", line: "Hreda zips 30 ZC.", detail: { amount: "30" }, tx: TX },
  { at: at + 6, who: "febric", action: "rest", line: `Febric reads by the window (job ${JOB}).` },
  { at: at + 7, who: "gladias", action: "rest", line: "Gladias walks the Kalimar paths." },
  { at: at + 8, who: "mov", action: "vote", line: "Mov answers poll #12.", detail: { pollId: "12", option: 1 }, job: JOB },
];

test("coarsening keeps who and what kind of thing, and drops the shop, item, amount, door, words and ids", () => {
  const rng = seeded(1);
  for (const e of sample(DAY0 + 14 * H)) {
    const c = coarsen(e, names, rng)!;
    assert.ok(c, e.action);
    assert.equal(c.who, e.who);
    assert.equal(c.action, e.action);
    for (const secret of ["Kalimar Kitchen", "salad", "10.5", "25", "140", "Number Ten", "Snow day", "30", "#12", JOB, TX]) assert.ok(!c.line.includes(secret), `${e.action}: "${c.line}" leaks ${secret}`);
    assert.deepEqual(Object.keys(c.detail ?? {}).filter((k) => k !== "to"), []);
  }
  // A private send may say whom it was for: the rezip's recipient isn't visible on-chain
  assert.deepEqual(coarsen(sample(0)[1], names, rng)!.detail, { to: "Febric" });
  // A resting line that touched no chain is kept when it's clean, replaced when it carries a number or an id
  assert.equal(coarsen(sample(0)[7], names, rng)!.line, "Gladias walks the Kalimar paths.");
  assert.match(coarsen(sample(0)[6], names, rng)!.line, /^Febric /);
  assert.doesNotMatch(coarsen(sample(0)[6], names, rng)!.line, /job|\d/);
  // Actions the story has no retelling for aren't told
  assert.equal(coarsen({ at: 0, who: "zei", action: "swap", line: "?" }, names, rng), null);
});

test("time of day is approximate and always true", () => {
  assert.equal(timeOfDay(DAY0 + 9 * H + 17 * MIN, DAY0 + 10 * H), "this morning");
  assert.equal(timeOfDay(DAY0 + 14 * H, DAY0 + 15 * H + 40 * MIN), "this afternoon");
  assert.equal(timeOfDay(DAY0 + 18 * H, DAY0 + 19 * H), "this evening");
  assert.equal(timeOfDay(DAY0 + 22 * H, DAY0 + 23 * H), "tonight");
  assert.equal(timeOfDay(DAY0 + 2 * H, DAY0 + 3 * H), "in the small hours");
  assert.equal(timeOfDay(DAY0 + 23 * H + 30 * MIN, DAY0 + 25 * H), "late last night");
  assert.equal(timeOfDay(DAY0 + 20 * H, DAY0 + 25 * H), "yesterday evening");
  assert.equal(timeOfDay(DAY0 + 10 * H, DAY0 + 3 * 24 * H), "earlier this week, in the morning");
});

test("delays are independent draws within the configured range", () => {
  assert.equal(delayMs(() => 0, 20, 120), 20 * MIN);
  assert.equal(delayMs(() => 0.5, 20, 120), 70 * MIN);
  assert.equal(delayMs(() => 0.999999, 20, 120), Math.round(119.9999 * MIN));
  assert.equal(delayMs(() => 0.5, 120, 20), 70 * MIN, "a swapped range still works");
  const rng = seeded(7);
  const ds = Array.from({ length: 500 }, () => delayMs(rng, 20, 120));
  assert.ok(ds.every((d) => d >= 20 * MIN && d <= 120 * MIN));
  assert.ok(new Set(ds).size > 400);
});

test("nothing is told before its delay; what is told is out of chain order and carries no 0x hex or job id", () => {
  let now = DAY0 + 14 * H;
  const story = new Story({ names, delayMinMin: 20, delayMaxMin: 120, now: () => now, rng: seeded(42) });
  const happened = sample(now);
  for (const e of happened) story.add(e);

  now += 19 * MIN;
  assert.deepEqual(story.flush(), [], "nothing before the minimum delay");
  assert.equal(story.feed().length, 0);

  const told: Told[] = [];
  for (let m = 20; m <= 121; m++) {
    now = DAY0 + 14 * H + m * MIN;
    told.push(...story.flush());
  }
  assert.equal(told.length, happened.length, "everything is told by the maximum delay");
  assert.equal(story.waiting, 0);
  assert.deepEqual(story.feed(), told);

  // The telling order is set by the independent delays, not by when things happened
  const order = told.map((t) => happened.findIndex((h) => h.who === t.who && h.action === t.action));
  assert.equal(new Set(order).size, happened.length);
  assert.notDeepEqual(order, [...order].sort((a, b) => a - b), "not in on-chain order");
  // `at` is the telling time and only grows, so `since` cursors work
  for (let i = 1; i < told.length; i++) assert.ok(told[i].at > told[i - 1].at);
  assert.ok(told.every((t) => t.at >= DAY0 + 14 * H + 20 * MIN));
  assert.ok(told.every((t) => t.when === "this afternoon"));
  assert.deepEqual(story.feed(told[3].at), told.slice(4));

  const wire = JSON.stringify(told);
  assert.doesNotMatch(wire, /0x[0-9a-f]+/i, "no 0x hex anywhere in what is published");
  assert.ok(!wire.includes(JOB), "no job id");
  assert.doesNotMatch(wire, /"(tx|job|hash|amount|base|tax|shop|item|door|burned|question|positionId)"/);
  for (const t of told) {
    assert.deepEqual(Object.keys(t).sort(), t.detail ? ["action", "at", "detail", "line", "when", "who"] : ["action", "at", "line", "when", "who"]);
    assert.doesNotMatch(t.line, /\d/);
  }
});

test("the told story and the pending queue persist across a restart; the private detail never reaches either", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-story-"));
  let now = DAY0 + 9 * H;
  const a = new Story({ names, delayMinMin: 20, delayMaxMin: 120, now: () => now, rng: seeded(3), dir });
  for (const e of sample(now)) a.add(e);
  now += 60 * MIN;
  const first = a.flush();

  const b = new Story({ names, delayMinMin: 20, delayMaxMin: 120, now: () => now, rng: seeded(4), dir });
  assert.deepEqual(b.feed(), first);
  assert.equal(b.waiting, sample(0).length - first.length);
  now += 61 * MIN;
  b.flush();
  assert.equal(b.feed().length, sample(0).length);

  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!text.includes(JOB) && !/0x[0-9a-f]+/i.test(text) && !text.includes("Kalimar Kitchen"), f);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
