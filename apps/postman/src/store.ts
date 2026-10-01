import fs from "node:fs";
import path from "node:path";

/**
 * The postman's state file: the ordered list of approved labels (every published root is a prefix of it), rejections,
 * and the last epoch whose root is confirmed on-chain. Losing it would mean re-deciding every approval, so:
 *
 * - Writes are atomic: a temporary file is written and fsynced, the current file is copied to `<file>.bak` (the last
 *   good state), and the temporary file is renamed over the current one. A crash leaves the old or the new file.
 * - Loading checks the shape. A corrupt or partial file is kept aside as `<file>.corrupt-<time>` and the backup is
 *   loaded instead, loudly. If the file exists and neither it nor the backup can be read, loading throws: the postman
 *   refuses to start rather than silently begin again with no approvals.
 */

export type Saved = {
  approved: string[];
  /** When each label was approved (unix sec). The daily cap counts approvals, not deposits, so queued deposits can't burst through. */
  approvedAt?: Record<string, number>;
  rejected: { label: string; depositor: string; reason: string }[];
  /** The last epoch whose root is confirmed on-chain (published, or found already there) */
  lastEpoch: number;
  /** When the on-chain root was last confirmed to be the approved set's (unix sec) */
  rootFreshAt?: number;
};

export const emptySaved = (): Saved => ({ approved: [], rejected: [], lastEpoch: -1 });

export class StateFileError extends Error {}

function parse(raw: string): Saved {
  const j = JSON.parse(raw) as Partial<Saved>;
  const labels = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string" && /^\d+$/.test(x));
  if (!j || typeof j !== "object") throw new Error("not an object");
  if (!labels(j.approved)) throw new Error("approved is not a list of labels");
  if (!Array.isArray(j.rejected) || !j.rejected.every((r) => r && typeof r.label === "string")) throw new Error("rejected is not a list");
  if (typeof j.lastEpoch !== "number" || !Number.isInteger(j.lastEpoch)) throw new Error("lastEpoch is missing");
  if (j.approvedAt !== undefined && (typeof j.approvedAt !== "object" || j.approvedAt === null)) throw new Error("approvedAt is not a map");
  return j as Saved;
}

const read = (file: string): { ok: true; saved: Saved } | { ok: false; error: string } | null => {
  if (!fs.existsSync(file)) return null;
  try {
    return { ok: true, saved: parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export function loadState(file: string, log: (m: string) => void = (m) => console.error(`[postman] ${m}`)): Saved {
  const bak = `${file}.bak`;
  const main = read(file);
  if (main?.ok) return main.saved;
  const backup = read(bak);
  if (main === null) {
    if (backup?.ok) {
      log(`${file} is missing but ${bak} is readable: loading the backup`);
      return backup.saved;
    }
    if (backup && !backup.ok) throw new StateFileError(`${file} is missing and ${bak} is unreadable (${backup.error}). Restore it from a backup; refusing to start with no approvals.`);
    return emptySaved();
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  fs.copyFileSync(file, aside);
  if (backup?.ok) {
    log(`${file} is unreadable (${main.error}); kept it as ${aside} and loaded the last good state from ${bak}. Approvals made since that save are decided again.`);
    return backup.saved;
  }
  throw new StateFileError(`${file} is unreadable (${main.error}) and there is no good backup (${bak}). Kept it as ${aside}. Restore the state file; refusing to start with no approvals.`);
}

export function saveState(file: string, saved: Saved) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(saved));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // The file being replaced was written the same way, so it is the last good state
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
  try {
    const d = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } catch {
    // Windows can't fsync a directory; the rename is still atomic there
  }
}
