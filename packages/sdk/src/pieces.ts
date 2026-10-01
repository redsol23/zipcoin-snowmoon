import { parseEther } from "viem";

import type { Note } from "./notes";

/**
 * Standard denominations. An unzip of 1,337.5 ZC is a fingerprint; ten unzips of 100, three of 10 and so on look like
 * everyone else's. Large unzips are split into standard pieces, each carried by a different courier at a different
 * random moment.
 *
 * The pool spends one note per proof and leaves one change note, so pieces cut from the same note have to be proved
 * one after another (the next piece spends the previous piece's change). `unzipInPieces` handles that: it waits for
 * each change note to land before proving the next piece. Pieces from different notes run independently.
 */

export const DENOMINATIONS = [1000, 500, 100, 50, 10, 5, 1].map((z) => parseEther(String(z)));

/** Greedy split into standard pieces; any remainder below the smallest denomination becomes one last piece. */
export function planPieces(amount: bigint, denoms: bigint[] = DENOMINATIONS, maxPieces = 12): bigint[] {
  const out: bigint[] = [];
  let left = amount;
  for (const d of denoms) {
    while (left >= d && out.length < maxPieces - 1) {
      out.push(d);
      left -= d;
    }
  }
  if (left > 0n) out.push(left);
  return out;
}

export type PieceStep = {
  piece: bigint;
  note: Note;
};

/**
 * Assigns pieces to notes, largest pieces to the notes that can hold them, spreading across notes first so fewer
 * pieces have to wait on a change note.
 */
export function assignPieces(pieces: bigint[], notes: Note[]): PieceStep[][] | null {
  const lanes = notes.map((n) => ({ note: n, left: n.value, steps: [] as PieceStep[] })).sort((a, b) => (a.left > b.left ? -1 : 1));
  for (const p of [...pieces].sort((a, b) => (a > b ? -1 : 1))) {
    const lane = lanes.filter((l) => l.left >= p).sort((a, b) => a.steps.length - b.steps.length)[0];
    if (!lane) return null;
    lane.steps.push({ piece: p, note: lane.note });
    lane.left -= p;
  }
  return lanes.filter((l) => l.steps.length).map((l) => l.steps);
}

/**
 * Runs each lane's pieces in order. `send` proves and hands one piece to a courier and returns once accepted;
 * `nextNote` resolves with the lane's change note once the previous piece has landed on-chain.
 */
export async function unzipInPieces(
  lanes: PieceStep[][],
  send: (note: Note, piece: bigint, laneIndex: number, stepIndex: number) => Promise<void>,
  nextNote: (spent: Note, piece: bigint) => Promise<Note>,
) {
  await Promise.all(
    lanes.map(async (steps, li) => {
      let note = steps[0].note;
      for (let si = 0; si < steps.length; si++) {
        await send(note, steps[si].piece, li, si);
        if (si < steps.length - 1) note = await nextNote(note, steps[si].piece);
      }
    }),
  );
}
