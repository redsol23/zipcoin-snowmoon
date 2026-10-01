import fs from "node:fs";
import path from "node:path";

/**
 * Replaces a file so a crash leaves either the old or the new contents, never a torn file: write a temporary file
 * next to it, fsync it, rename it over the old one, then fsync the directory (where the platform allows it).
 */
export function atomicWrite(file: string, data: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // Windows can't open a directory for fsync; the rename is still atomic there
  }
}
