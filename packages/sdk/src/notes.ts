import { openSecrets } from "./crypto";
import type { PoolState } from "./indexer";
import { depositSecrets, withdrawalSecrets, type MasterKeys, type NoteSecrets } from "./keys";
import { hashCommitment, hashNullifier, hashPrecommitment } from "./tree";

export type Note = {
  label: bigint;
  value: bigint;
  nullifier: bigint;
  secret: bigint;
  commitment: bigint;
  /** How many times this label has been partially spent; the next change note uses withdrawalSecrets(label, children). */
  children: bigint;
  origin: "deposit" | "received" | "link";
};

/**
 * Finds every live note a zip key controls, from public events only. Nothing leaves the device.
 *
 * Roots of ownership: the key's own deposits (depositSecrets i = 0, 1, …), notes rezipped to its zip address (the
 * ciphertext decrypts), and any zip links it was handed. From each root the spend chain is walked: every partial spend
 * leaves a change note with withdrawalSecrets(label, k) of the spender's key.
 */
export function recoverNotes(
  k: MasterKeys,
  scope: bigint,
  state: PoolState,
  opts: { zipAddressKey?: Uint8Array; links?: NoteSecrets[] } = {},
) {
  const byPre = new Map(state.deposits.map((d) => [d.precommitment, d]));
  const bySpent = new Map(state.withdrawals.map((w) => [w.spentNullifier, w]));
  const ragequit = new Set(state.ragequits.map((r) => r.label));

  const roots: { s: NoteSecrets; origin: Note["origin"] }[] = [];
  let nextDepositIndex = 0n;
  for (let i = 0n, misses = 0; misses < 5; i++) {
    const s = depositSecrets(k, scope, i);
    if (byPre.has(hashPrecommitment(s.nullifier, s.secret))) {
      roots.push({ s, origin: "deposit" });
      nextDepositIndex = i + 1n;
      misses = 0;
    } else misses++;
  }
  if (opts.zipAddressKey) {
    for (const r of state.rezips) {
      const s = openSecrets(opts.zipAddressKey, r.ciphertext);
      if (s) roots.push({ s, origin: "received" });
    }
  }
  for (const s of opts.links ?? []) roots.push({ s, origin: "link" });

  const notes: Note[] = [];
  for (const { s, origin } of roots) {
    const d = byPre.get(hashPrecommitment(s.nullifier, s.secret));
    if (!d) continue;
    let note: Note = { label: d.label, value: d.value, nullifier: s.nullifier, secret: s.secret, commitment: d.commitment, children: 0n, origin };
    for (;;) {
      const w = bySpent.get(hashNullifier(note.nullifier));
      if (!w) break;
      const c = withdrawalSecrets(k, note.label, note.children);
      const value = note.value - w.value;
      const commitment = hashCommitment(value, note.label, hashPrecommitment(c.nullifier, c.secret));
      // Spent by someone else's key (e.g. a link we handed out and the recipient claimed): not ours any more
      if (commitment !== w.newCommitment) {
        note = { ...note, value: 0n };
        break;
      }
      note = { ...note, value, nullifier: c.nullifier, secret: c.secret, commitment, children: note.children + 1n };
    }
    if (note.value > 0n && !ragequit.has(note.label)) notes.push(note);
  }
  return { notes, nextDepositIndex, balance: notes.reduce((a, n) => a + n.value, 0n) };
}
