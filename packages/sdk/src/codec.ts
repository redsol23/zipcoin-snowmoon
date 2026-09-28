import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from "viem";

/**
 * `withdrawal.data` encoders, one per processooor. Each mirrors its Solidity struct field-for-field; the proof's
 * `context` commits to these bytes, so what is encoded here is exactly what the chain will execute.
 */

export type Courier = { feeRecipient: Address; fee: bigint };
export const NO_COURIER: Courier = { feeRecipient: "0x0000000000000000000000000000000000000000", fee: 0n };

const courier = { name: "courier", type: "tuple", components: [{ name: "feeRecipient", type: "address" }, { name: "fee", type: "uint256" }] } as const;

/** Entrypoint.relay: plain unzip to an address. */
export const encodeRelay = (recipient: Address, feeRecipient: Address, relayFeeBPS: bigint) =>
  encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
    [{ recipient, feeRecipient, relayFeeBPS }],
  );

export type Speech = { topic: Hex; groupId: bigint; message: string; target: string; payload: string; courier: Courier };
export const encodeSpeech = (s: Speech) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "topic", type: "bytes32" },
          { name: "groupId", type: "uint256" },
          { name: "message", type: "string" },
          { name: "target", type: "string" },
          { name: "payload", type: "string" },
          courier,
        ],
      },
    ],
    [s],
  );

export type Knock = { door: Address; gift: bigint; message: string; courier: Courier };
export const encodeKnock = (k: Knock) =>
  encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "door", type: "address" }, { name: "gift", type: "uint256" }, { name: "message", type: "string" }, courier] }],
    [k],
  );

export type Send = { precommitment: bigint; ciphertext: Hex; courier: Courier };
export const encodeSend = (s: Send) =>
  encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "precommitment", type: "uint256" }, { name: "ciphertext", type: "bytes" }, courier] }],
    [s],
  );

export type Payment = {
  merchantId: bigint;
  base: bigint;
  orderId: Hex;
  payeePrecommitment: bigint;
  identityCommitment: bigint;
  receipt: Hex;
  courier: Courier;
};
export const encodePayment = (p: Payment) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "merchantId", type: "uint256" },
          { name: "base", type: "uint256" },
          { name: "orderId", type: "bytes32" },
          { name: "payeePrecommitment", type: "uint256" },
          { name: "identityCommitment", type: "uint256" },
          { name: "receipt", type: "bytes" },
          courier,
        ],
      },
    ],
    [p],
  );

export type LockRequest = { identityCommitment: bigint; duration: bigint; returnPrecommitment: bigint; courier: Courier };
export const encodeLock = (r: LockRequest) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "identityCommitment", type: "uint256" },
          { name: "duration", type: "uint64" },
          { name: "returnPrecommitment", type: "uint256" },
          courier,
        ],
      },
    ],
    [r],
  );

export type PollCreation = {
  groupId: bigint;
  question: string;
  optionCount: number;
  duration: bigint;
  burn: bigint;
  rewardPerVote: bigint;
  maxVotes: bigint;
  courier: Courier;
};
export const encodePollCreation = (c: PollCreation) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "groupId", type: "uint256" },
          { name: "question", type: "string" },
          { name: "optionCount", type: "uint8" },
          { name: "duration", type: "uint64" },
          { name: "burn", type: "uint256" },
          { name: "rewardPerVote", type: "uint256" },
          { name: "maxVotes", type: "uint256" },
          courier,
        ],
      },
    ],
    [c],
  );

/** Decodes the Courier field of any processooor payload (it is always the last struct member). */
export function payloadCourier(target: ProcessooorKind, data: Hex): Courier {
  if (target === "relay") {
    const [r] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
      data,
    );
    return { feeRecipient: r.feeRecipient, fee: r.relayFeeBPS };
  }
  const [p] = decodeAbiParameters([{ type: "tuple", components: PAYLOAD_FIELDS[target] }], data) as unknown as [{ courier: Courier }];
  return p.courier;
}

export type ProcessooorKind = "relay" | "speak" | "knock" | "rezip" | "pay" | "lock" | "poll";

const PAYLOAD_FIELDS = {
  speak: [
    { name: "topic", type: "bytes32" },
    { name: "groupId", type: "uint256" },
    { name: "message", type: "string" },
    { name: "target", type: "string" },
    { name: "payload", type: "string" },
    courier,
  ],
  knock: [{ name: "door", type: "address" }, { name: "gift", type: "uint256" }, { name: "message", type: "string" }, courier],
  rezip: [{ name: "precommitment", type: "uint256" }, { name: "ciphertext", type: "bytes" }, courier],
  pay: [
    { name: "merchantId", type: "uint256" },
    { name: "base", type: "uint256" },
    { name: "orderId", type: "bytes32" },
    { name: "payeePrecommitment", type: "uint256" },
    { name: "identityCommitment", type: "uint256" },
    { name: "receipt", type: "bytes" },
    courier,
  ],
  lock: [
    { name: "identityCommitment", type: "uint256" },
    { name: "duration", type: "uint64" },
    { name: "returnPrecommitment", type: "uint256" },
    courier,
  ],
  poll: [
    { name: "groupId", type: "uint256" },
    { name: "question", type: "string" },
    { name: "optionCount", type: "uint8" },
    { name: "duration", type: "uint64" },
    { name: "burn", type: "uint256" },
    { name: "rewardPerVote", type: "uint256" },
    { name: "maxVotes", type: "uint256" },
    courier,
  ],
} as const;
