import { buildTree } from "@zipnet/sdk";

/**
 * The pool's state roots and the ASP root, as a courier follows them: kept incrementally (never a whole-tree rebuild
 * per refresh or request), so a held pool proof can be sent while its roots are still accepted.
 */

// ---------------------------------------------------------------------------------------------------------------
// the ASP root
// ---------------------------------------------------------------------------------------------------------------

/**
 * Whether the ASP root is about to change under a pool proof. A pool spend must name the Entrypoint's latest ASP root,
 * and the postman replaces it once per epoch, a few seconds (a tick, then a block; minutes on a congested chain) after
 * the epoch turns. In that window a proof on the current root still simulates, but a held job made from it fails
 * (IncorrectASPRoot) as soon as the new root lands. So: the postman hasn't published this epoch yet (its lastEpoch is
 * behind) and its approved set's root differs from the chain's (the publish will change it).
 */
export function aspPublishPending(o: { now: number; epochSec: number; lastEpoch: number; postmanRoot: bigint; onchainRoot: bigint }) {
  return Math.floor(o.now / o.epochSec) > o.lastEpoch && o.postmanRoot !== o.onchainRoot;
}

/**
 * Watching the ASP epoch turn (state.ts watchAspTurn). The state refresh reads the chain's ASP root every 10 s, so for
 * up to 10 s after the postman's publish landed the courier would still serve the old labels at /asp, and wallets
 * would prove on a root the chain had just replaced (IncorrectASPRoot). From the turn until this epoch's publish is
 * seen, the courier looks every second and serves the new root as soon as the chain has it. `aspTurnWatched` is the
 * epoch to watch now, or null: none yet, already seen, or more than `windowSec` past the turn (the 10 s refresh takes
 * over then: a postman that late is having problems).
 */
export function aspTurnWatched(now: number, epochSec: number, seenEpoch: number, windowSec: number): number | null {
  if (!(epochSec > 0)) return null;
  const epoch = Math.floor(now / epochSec);
  return epoch > seenEpoch && now - epoch * epochSec <= windowSec ? epoch : null;
}

/**
 * How a held pool proof that arrives too close to the end of its ASP epoch for a receipt is handled. Its deadline is
 * the epoch end minus EPOCH_MARGIN_SEC, and it must go out `lead` before that, so in the last margin + lead of every
 * epoch (7 minutes of a 4 h epoch with the defaults) such a job used to be refused, and the wallet resent it with
 * holdSec 0 anyway (the refusal says to). It is sent at once instead, without a receipt, as that resend would be:
 * "send". Only in the last `guardSec` before the turn (ASP_TURN_GUARD_SEC, about a block), where even a transaction
 * sent now may land after the new root, is it still refused: "refuse".
 */
export function lateHeldPoolProof(now: number, epochEnd: number, guardSec: number): "send" | "refuse" {
  return epochEnd - now > guardSec ? "send" : "refuse";
}

/**
 * The postman's approved labels as the chain has them: the longest prefix of its list whose tree root is the
 * Entrypoint's latest root (the list may already hold labels for the next epoch). The list only grows, so the tree is
 * kept and extended with the root after every label, and a refresh hashes only the new labels. Rebuilding the whole
 * tree once per candidate length on every refresh blocked the event loop for seconds once a few hundred labels were
 * waiting to be published. On a fresh start only the last `tail` roots are computed one label at a time (the rest go
 * in at once); a match further back than that rebuilds with every root, once.
 */
export class AspPrefix {
  private labels: bigint[] = [];
  private tree = buildTree([]);
  /** roots[i]: the root of the first from + i + 1 labels */
  private roots: bigint[] = [];
  private from = 0;

  constructor(private readonly tail = 4096) {}

  /** Length of the longest prefix of `labels` whose root is `root` (0: none) */
  match(labels: readonly bigint[], root: bigint): number {
    const grows = labels.length >= this.labels.length && this.labels.every((l, i) => l === labels[i]);
    if (!grows || (this.labels.length === 0 && labels.length > this.tail)) this.rebuild(labels, this.tail);
    for (let i = this.labels.length; i < labels.length; i++) this.add(labels[i]);
    let n = this.find(root);
    if (n === 0 && this.from > 0) {
      this.rebuild(labels, Infinity);
      n = this.find(root);
    }
    return n;
  }

  private rebuild(labels: readonly bigint[], tail: number) {
    this.from = Math.max(0, labels.length - tail);
    this.labels = labels.slice(0, this.from);
    this.tree = buildTree(this.labels);
    this.roots = [];
    for (let i = this.from; i < labels.length; i++) this.add(labels[i]);
  }

  private add(label: bigint) {
    this.tree.insert(label);
    this.labels.push(label);
    this.roots.push(this.tree.root);
  }

  private find(root: bigint) {
    for (let i = this.roots.length - 1; i >= 0; i--) if (this.roots[i] === root) return this.from + i + 1;
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the pool's state roots
// ---------------------------------------------------------------------------------------------------------------

/**
 * A pool spend proof names a state root, and the pool accepts only its last POOL_ROOT_HISTORY roots (every insert, a
 * deposit or a spend's change note, makes a new one: 0xbow State.ROOT_HISTORY_SIZE). So a held pool proof lives for
 * 64 inserts, whatever its epoch deadline says, and on a busy pool that comes first: a receipted job held for its
 * random moment would hit UnknownStateRoot at send time. The courier therefore counts each held proof's root age in
 * inserts and sends it once the age plus the pool spends going out with it reaches the history minus
 * POOL_ROOT_MARGIN: earlier than planned, but on chain, as the receipt promised.
 */
export const POOL_ROOT_HISTORY = 64;
export const POOL_ROOT_MARGIN = 16;

/** Seconds between noticing the pressure and the send landing: a deliver tick (5 s) and an inclusion or two */
export const POOL_ROOT_LOOKAHEAD_SEC = 20;

/**
 * Whether pool proofs of these root ages (in inserts), all going out together, must go now: their oldest age, plus
 * their own inserts, plus the inserts expected before they land (`ratePerSec` × the lookahead) reaches the history
 * minus the margin. On a busy pool the rate is what matters: at two inserts a second, a proof's root lives about half
 * a minute.
 */
export function poolRootPressed(ages: readonly number[], ratePerSec = 0, history = POOL_ROOT_HISTORY, margin = POOL_ROOT_MARGIN, lookaheadSec = POOL_ROOT_LOOKAHEAD_SEC) {
  return ages.length > 0 && Math.max(...ages) + ages.length + Math.ceil(ratePerSec * lookaheadSec) >= history - margin;
}

/** The pool's insert rate from (unix ms, tree size) samples over the last `windowMs` */
export class InsertRate {
  private samples: { t: number; size: number }[] = [];

  constructor(private readonly windowMs = 60_000) {}

  add(t: number, size: number) {
    this.samples = [...this.samples.filter((s) => t - s.t <= this.windowMs), { t, size }];
  }

  /** Inserts per second, 0 until two samples are apart */
  perSec() {
    const a = this.samples[0];
    const b = this.samples.at(-1);
    return a && b && b.t > a.t ? Math.max(0, b.size - a.size) / ((b.t - a.t) / 1000) : 0;
  }
}

/** The pool's recent state roots, each with the tree size it had, kept from the leaves as they are synced */
export class RecentRoots {
  private tree = buildTree([]);
  private sizeAt = new Map<bigint, number>();

  constructor(private readonly keep = 4 * POOL_ROOT_HISTORY) {}

  /** The tree's root now (0 while empty, as the pool reads it): state.ts checks the synced leaves against the chain with it */
  get root(): bigint {
    return this.tree.size ? this.tree.root : 0n;
  }

  /** Forgets everything (after a resync from scratch) */
  reset() {
    this.tree = buildTree([]);
    this.sizeAt.clear();
  }

  /** Follows the leaves (append-only; a shorter list, a resync, starts over) */
  update(leaves: readonly bigint[]) {
    if (leaves.length < this.tree.size) this.reset();
    // Only the roots worth remembering are computed one insert at a time; the rest go in at once
    if (this.tree.size === 0 && leaves.length > this.keep) this.tree = buildTree(leaves.slice(0, leaves.length - this.keep));
    for (let i = this.tree.size; i < leaves.length; i++) {
      this.tree.insert(leaves[i]);
      this.sizeAt.set(this.tree.root, i + 1);
    }
    for (const k of this.sizeAt.keys()) {
      if (this.sizeAt.size <= this.keep) break;
      this.sizeAt.delete(k);
    }
  }

  /**
   * Inserts since `root` was the pool's root, or null if it isn't a recent one (too old, or newer than what we saw).
   * `sizeNow`: the tree's size on chain, fresher than the last sync.
   */
  age(root: bigint, sizeNow = this.tree.size): number | null {
    const n = this.sizeAt.get(root);
    return n === undefined ? null : Math.max(sizeNow, this.tree.size) - n;
  }
}
