import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";

import { fundingOf, noteFundedIn, type FundingIo, type TxLog, type TxView } from "./trust";

const POOL = "0x00000000000000000000000000000000000000a1" as Address;
const ZC = "0x00000000000000000000000000000000000000a2" as Address;
const REZIP = "0x00000000000000000000000000000000000000a3" as Address;
const BADGES = "0x00000000000000000000000000000000000000a4" as Address;
const WALLET = "0x00000000000000000000000000000000000000b1" as Address;
const COURIER = "0x00000000000000000000000000000000000000b2" as Address;
const ENTRYPOINT = "0x00000000000000000000000000000000000000b3" as Address;
const ctx = { pool: POOL, zc: ZC, badges: BADGES };

const abi = parseAbi([
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Unlocked(uint256 indexed lockId, uint256 commitment)",
]);

const withdrawn = (processooor: Address, value: bigint): TxLog => ({
  address: POOL,
  topics: encodeEventTopics({ abi, eventName: "Withdrawn", args: { _processooor: processooor } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [value, 1n, 2n]),
});
const deposited = (depositor: Address, value: bigint, commitment = 7n): TxLog => ({
  address: POOL,
  topics: encodeEventTopics({ abi, eventName: "Deposited", args: { _depositor: depositor } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [commitment, 3n, value, 4n]),
});
const transfer = (from: Address, to: Address, value: bigint): TxLog => ({
  address: ZC,
  topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const unlocked = (lockId: bigint, commitment: bigint): TxLog => ({
  address: BADGES,
  topics: encodeEventTopics({ abi, eventName: "Unlocked", args: { lockId } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [commitment]),
});
const tx = (hash: string, from: Address, logs: TxLog[]): TxView => ({ hash: hash as Hex, from, logs });

const io = (txs: TxView[], locks: Record<string, Hex> = {}): FundingIo => ({
  tx: async (h) => {
    const t = txs.find((x) => x.hash === h);
    if (!t) throw new Error(`no tx ${h}`);
    return t;
  },
  lockTx: async (id) => locks[id.toString()] ?? null,
});

// A courier-relayed rezip: the pool pays ZipRezip out of a note, the courier takes its fee, the rest is deposited
const rezip = tx("0x01", COURIER, [transfer(POOL, REZIP, 10n), withdrawn(REZIP, 10n), transfer(REZIP, COURIER, 1n), transfer(REZIP, ENTRYPOINT, 9n), deposited(REZIP, 9n)]);
// ZipRezip.zipTo from a wallet: the ZC comes from the wallet, no note is spent
const zipTo = tx("0x02", WALLET, [transfer(WALLET, REZIP, 50n), transfer(REZIP, ENTRYPOINT, 50n), deposited(REZIP, 50n)]);

test("a rezip funded by a note spent in the same transaction is note-funded", async () => {
  assert.deepEqual(noteFundedIn(rezip, REZIP, ctx), { ok: true });
  assert.deepEqual(await fundingOf({ depositor: REZIP, tx: "0x01", commitment: 7n }, ctx, io([rezip])), { noteFunded: true });
});

test("zipTo from a wallet is a public deposit, screened and capped by that wallet", async () => {
  const f = await fundingOf({ depositor: REZIP, tx: "0x02", commitment: 7n }, ctx, io([zipTo]));
  assert.equal(f.noteFunded, false);
  assert.equal(!f.noteFunded && f.origin, WALLET);
});

test("a note spend bundled with a wallet top-up in one transaction is not note-funded", () => {
  // e.g. a multicall: rezip a 100 ZC note paying a 99 ZC "fee" to itself, then zipTo 99 ZC from a sanctioned wallet
  const mixed = tx("0x03", WALLET, [
    transfer(POOL, REZIP, 100n),
    withdrawn(REZIP, 100n),
    transfer(REZIP, WALLET, 99n),
    deposited(REZIP, 1n),
    transfer(WALLET, REZIP, 99n),
    deposited(REZIP, 99n),
  ]);
  const r = noteFundedIn(mixed, REZIP, ctx);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /from 0x0+b1/i);
});

test("deposits beyond what the notes paid in are not note-funded", () => {
  const over = tx("0x04", COURIER, [transfer(POOL, REZIP, 10n), withdrawn(REZIP, 10n), deposited(REZIP, 9n), deposited(REZIP, 5n)]);
  assert.match((noteFundedIn(over, REZIP, ctx) as { reason: string }).reason, /deposited 14 but only 10/);
  // a note spent by some other processooor (e.g. a relay) doesn't fund our contract's deposit
  const other = tx("0x05", COURIER, [withdrawn(ENTRYPOINT, 10n), deposited(REZIP, 9n)]);
  assert.equal(noteFundedIn(other, REZIP, ctx).ok, false);
});

test("a badge unlock is note-funded only if its lock was (lockAnon), else the locker's wallet is the origin", async () => {
  const unlock = tx("0x10", COURIER, [transfer(BADGES, ENTRYPOINT, 100n), deposited(BADGES, 100n, 55n), unlocked(9n, 55n)]);
  const lockAnon = tx("0x11", COURIER, [transfer(POOL, BADGES, 101n), withdrawn(BADGES, 101n), transfer(BADGES, COURIER, 1n)]);
  const lockWallet = tx("0x12", WALLET, [transfer(WALLET, BADGES, 100n)]);
  const d = { depositor: BADGES, tx: "0x10" as Hex, commitment: 55n };
  assert.deepEqual(await fundingOf(d, ctx, io([unlock, lockAnon], { "9": "0x11" })), { noteFunded: true });
  const pub = await fundingOf(d, ctx, io([unlock, lockWallet], { "9": "0x12" }));
  assert.equal(!pub.noteFunded && pub.origin, WALLET);
  // the Unlocked event must be this deposit's (same commitment)
  const notOurs = await fundingOf({ ...d, commitment: 56n }, ctx, io([unlock, lockAnon], { "9": "0x11" }));
  assert.equal(!notOurs.noteFunded && notOurs.origin, COURIER);
});
