import fs from "node:fs";
import path from "node:path";

import { atomicWrite } from "./files";

/**
 * Where a courier's jobs live on disk: a snapshot (jobs.json, every job as a JSON array, the format it always had) and
 * an append log after it (jobs.log, one line per change: the job's whole state, or `{"id","deleted":true}`).
 *
 * The courier used to rewrite all of jobs.json, fsynced, on every change to any job: on a busy courier about 1 MB per
 * write, several times per job, and it only grew: nothing was ever removed. Now a change appends
 * the changed jobs' lines and fsyncs the log before `save` returns, so whatever the courier says next (a signed
 * receipt above all) is already on disk; the snapshot is rewritten only at compaction: on start, after a prune, and
 * when the log has more lines than COMPACT_LINES or twice the live jobs.
 *
 * Loading reads the snapshot, then replays the log in order (last line per id wins; a deletion removes it). A crash
 * mid-append leaves at most a torn last line, which is skipped. Compaction writes the snapshot atomically (files.ts)
 * and only then empties the log, so a crash between the two replays a log the snapshot already holds, to the same
 * state; a prune logs its deletions before compacting, so a crash in between can't bring pruned jobs back.
 *
 * Pruning: a job that ended (sent or failed) is dropped `retentionMs` (JOBS_RETENTION_DAYS, 7) after it ended
 * (`doneAt`, set when it is first saved in an end state; older files without it count from submitAt). Jobs still held
 * or being sent are never dropped.
 */

export type StoredJob = { id: string; status: string; submitAt: number; doneAt?: number };

/** End states: nothing more happens to such a job, so it only waits out its retention */
export const DONE: ReadonlySet<string> = new Set(["sent", "failed"]);

/** Log lines (beyond twice the live jobs) that trigger a compaction */
export const COMPACT_LINES = 2000;

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (_k: string, v: unknown) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export class JobStore<J extends StoredJob> {
  readonly jobs = new Map<string, J>();
  readonly snapshotFile: string;
  readonly logFile: string;
  private fd: number | null = null;
  private logLines = 0;

  constructor(
    dir: string,
    private readonly o: { retentionMs: number; compactLines?: number; now?: () => number; log?: (m: string) => void },
  ) {
    this.snapshotFile = path.join(dir, "jobs.json");
    this.logFile = path.join(dir, "jobs.log");
    if (fs.existsSync(this.snapshotFile)) for (const j of JSON.parse(fs.readFileSync(this.snapshotFile, "utf8"), unbig) as J[]) this.jobs.set(j.id, j);
    if (fs.existsSync(this.logFile)) {
      const lines = fs.readFileSync(this.logFile, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!l.trim()) return;
        try {
          const r = JSON.parse(l, unbig) as J & { deleted?: boolean };
          if (r.deleted) this.jobs.delete(r.id);
          else this.jobs.set(r.id, r);
        } catch {
          // Only a crash mid-append tears a line, and only the last one
          this.o.log?.(`jobs.log line ${i + 1} of ${lines.length} is torn; skipped`);
        }
      });
    }
    this.prune();
    this.compact();
  }

  private get now() {
    return (this.o.now ?? Date.now)();
  }

  /**
   * Records these jobs' current state (and adds new ones): appended to the log and fsynced before it returns, so a
   * reply sent after it (a receipt) survives a crash. Nothing else is rewritten.
   */
  save(...js: J[]) {
    if (!js.length) return;
    const now = this.now;
    let out = "";
    for (const j of js) {
      if (DONE.has(j.status)) j.doneAt ??= now;
      else delete j.doneAt;
      this.jobs.set(j.id, j);
      out += JSON.stringify(j, big) + "\n";
    }
    this.append(out);
    this.logLines += js.length;
    if (this.logLines >= Math.max(this.o.compactLines ?? COMPACT_LINES, 2 * this.jobs.size)) this.compact();
  }

  /** Drops jobs that ended more than the retention ago (their deletions logged first, then compacted); how many */
  prune(): number {
    const cut = this.now - this.o.retentionMs;
    const gone = [...this.jobs.values()].filter((j) => DONE.has(j.status) && (j.doneAt ?? j.submitAt) < cut);
    if (!gone.length) return 0;
    this.append(gone.map((j) => JSON.stringify({ id: j.id, deleted: true }) + "\n").join(""));
    for (const j of gone) this.jobs.delete(j.id);
    this.compact();
    return gone.length;
  }

  /** The snapshot rewritten with every live job (atomically), then the log emptied */
  compact() {
    atomicWrite(this.snapshotFile, JSON.stringify([...this.jobs.values()], big));
    // Reopened to empty it (an append-only handle can't be truncated on Windows); the next append opens it again
    this.close();
    const fd = fs.openSync(this.logFile, "w");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.logLines = 0;
  }

  /** Closes the log (tests; the courier keeps it open for its lifetime) */
  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  private append(s: string) {
    this.fd ??= fs.openSync(this.logFile, "a");
    fs.writeSync(this.fd, s);
    fs.fdatasyncSync(this.fd);
  }
}
