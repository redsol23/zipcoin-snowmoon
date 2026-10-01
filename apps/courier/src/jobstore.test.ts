import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { JobStore, type StoredJob } from "./jobstore";

type J = StoredJob & { kind?: string; receipt?: { nullifierHash: bigint }; tx?: string };

const DAY = 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jobstore-"));
const open = (dir: string, now = () => 1_000 * DAY, compactLines?: number) => new JobStore<J>(dir, { retentionMs: 7 * DAY, now, compactLines });
const job = (id: string, status: string, e: Partial<J> = {}): J => ({ id, status, submitAt: 1_000 * DAY, ...e });
const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;

test("jobstore: a change appends the changed job to the log; the snapshot isn't rewritten", () => {
  const dir = tmp();
  const s = open(dir);
  for (let i = 0; i < 50; i++) s.save(job(`j${i}`, "sent"));
  const snap = fs.readFileSync(s.snapshotFile, "utf8");
  const a = s.jobs.get("j1")!;
  a.status = "held";
  s.save(a);
  assert.equal(fs.readFileSync(s.snapshotFile, "utf8"), snap, "snapshot untouched");
  assert.equal(lines(s.logFile), 51, "one line per change");
  s.close();
});

test("jobstore: a restart (no compaction since) finds every change, a receipted held job included, bigints intact", () => {
  const dir = tmp();
  const s = open(dir);
  const held = job("r", "held", { kind: "relay", receipt: { nullifierHash: 2n ** 200n + 1n } });
  s.save(held, job("x", "sending"));
  held.status = "sending";
  held.tx = "0xabc";
  s.save(held);
  s.close(); // a crash: nothing else happens
  const t = open(dir);
  assert.equal(t.jobs.size, 2);
  assert.equal(t.jobs.get("r")!.status, "sending");
  assert.equal(t.jobs.get("r")!.tx, "0xabc");
  assert.equal(t.jobs.get("r")!.receipt!.nullifierHash, 2n ** 200n + 1n);
  assert.equal(lines(t.logFile), 0, "folded into the snapshot on start");
  t.close();
  assert.equal(open(dir).jobs.get("r")!.status, "sending", "and again from the snapshot alone");
});

test("jobstore: a torn last line (crash mid-append) is skipped; the lines before it hold", () => {
  const dir = tmp();
  const s = open(dir);
  s.save(job("a", "held"));
  s.save(job("b", "held"));
  s.close();
  fs.appendFileSync(path.join(dir, "jobs.log"), '{"id":"c","status":"he');
  const notes: string[] = [];
  const t = new JobStore<J>(dir, { retentionMs: 7 * DAY, now: () => 1_000 * DAY, log: (m) => notes.push(m) });
  assert.deepEqual([...t.jobs.keys()].sort(), ["a", "b"]);
  assert.equal(notes.length, 1);
  t.close();
});

test("jobstore: jobs that ended are pruned after the retention, held and sending ones never", () => {
  const dir = tmp();
  let now = 1_000 * DAY;
  const s = open(dir, () => now);
  s.save(job("sent", "sent"), job("failed", "failed"), job("held", "held"), job("sending", "sending"));
  now += 3 * DAY;
  s.save(job("late", "sent"));
  assert.equal(s.prune(), 0, "nothing older than 7 days yet");
  now += 5 * DAY;
  assert.equal(s.prune(), 2);
  assert.deepEqual([...s.jobs.keys()].sort(), ["held", "late", "sending"]);
  now += 3 * DAY;
  assert.equal(s.prune(), 1, "the later one in its turn");
  s.close();
  assert.deepEqual([...open(dir, () => now).jobs.keys()].sort(), ["held", "sending"], "a restart doesn't bring them back");
});

test("jobstore: doneAt is when a job ended, not when it was submitted; a job moving on from an end state loses it", () => {
  const dir = tmp();
  let now = 1_000 * DAY;
  const s = open(dir, () => now);
  const j = job("a", "held", { submitAt: 900 * DAY });
  s.save(j);
  assert.equal(j.doneAt, undefined);
  now += DAY;
  j.status = "sent";
  s.save(j);
  assert.equal(j.doneAt, 1_001 * DAY);
  s.save(j);
  assert.equal(j.doneAt, 1_001 * DAY, "kept on later saves");
  j.status = "held";
  s.save(j);
  assert.equal(j.doneAt, undefined);
  s.close();
});

test("jobstore: a crash after a prune's snapshot but before the log is emptied doesn't resurrect pruned jobs", () => {
  const dir = tmp();
  // The snapshot already without "old"; the log still holding its lines and the deletion logged before compaction
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([job("keep", "held")]));
  fs.writeFileSync(
    path.join(dir, "jobs.log"),
    [JSON.stringify(job("old", "sent", { doneAt: 1 })), JSON.stringify(job("keep", "held")), JSON.stringify({ id: "old", deleted: true })].join("\n") + "\n",
  );
  const s = open(dir);
  assert.deepEqual([...s.jobs.keys()], ["keep"]);
  s.close();
});

test("jobstore: the log is compacted once it outgrows the live jobs; nothing is lost across it or a restart", () => {
  const dir = tmp();
  const s = open(dir, undefined, 10);
  const a = job("a", "held");
  s.save(a, job("b", "sending"), job("c", "sent"));
  for (let i = 0; i < 25; i++) {
    a.tx = `0x${i}`;
    s.save(a);
  }
  assert.equal(lines(s.logFile), 8, "28 changes, compacted at 10 lines and at 20");
  const snapshot = JSON.parse(fs.readFileSync(s.snapshotFile, "utf8")) as J[];
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot.find((j) => j.id === "a")!.tx, "0x16", "as of the last compaction");
  s.close();
  const t = open(dir);
  assert.equal(t.jobs.size, 3);
  assert.equal(t.jobs.get("a")!.tx, "0x24", "the snapshot plus the log after it");
  t.close();
});

test("jobstore: a jobs.json from before the log (a plain array) loads as it was", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([{ ...job("old", "held"), receipt: { nullifierHash: "7n" } }]));
  const s = open(dir);
  assert.equal(s.jobs.get("old")!.receipt!.nullifierHash, 7n);
  s.close();
});
