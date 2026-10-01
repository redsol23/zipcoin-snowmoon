// Emerald's tools. Pure: no React, no network, no wallet. The route sends the schemas to the model; the browser
// validates a proposal (parseBaseProposal) before any card appears, so a malformed or
// out-of-range call never reaches Confirm.
import { isAddress, parseEther } from "viem";

/** A tool as a name, a description and a JSON schema; deepseek.ts turns it into the OpenAI function format. */
export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
};

const str = { type: "string" } as const;
const strOrNull = { type: ["string", "null"] } as const;
const obj = (properties: Record<string, unknown>): ToolSpec["input_schema"] => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const noInput = obj({});

/** The wallet's original tools: balances, recipients, merchants, door and board, pool timing, and payments. */
export const BASE_TOOLS: ToolSpec[] = [
  {
    name: "get_wallet",
    description: "The person's balances: zipped (private) total, largest spendable note, amount waiting to be cleared, public wallet ZC, badge tier, whether their zip address is set up, and their public address.",
    input_schema: noInput,
  },
  {
    name: "check_recipient",
    description: "Look up an address before sending or paying: whether it is this person, a registered zip address, a listed merchant (and which), a contract, and its ENS-free label if known.",
    input_schema: obj({ address: str }),
  },
  { name: "list_merchants", description: "Merchants that accept zipcoin with sales tax, with their ids, and the tax rate.", input_schema: noInput },
  { name: "read_inbox", description: "Burns at this person's door (largest first), recent anonymous board posts, and open polls they can answer.", input_schema: noInput },
  { name: "pool_activity", description: "How busy the privacy pool is: recent deposits and spends per hour, crowd size, and a suggested courier hold.", input_schema: noInput },
  {
    name: "propose_action",
    description:
      "Show the person a card for one action they can confirm or dismiss. Amounts are in ZC as decimal strings. zip: amount. send: amount + to (address). send_link: amount. pay: merchant_id + amount (the base price; tax is added). unzip: amount + to. speak: amount (burn) + message (+ target, a description of who it's for). knock: to + amount (burn) + message.",
    input_schema: obj({
      action: { type: "string", enum: ["zip", "send", "send_link", "pay", "unzip", "speak", "knock"] },
      amount_zc: str,
      to: strOrNull,
      merchant_id: strOrNull,
      message: strOrNull,
      target: strOrNull,
      hold: { type: "string", enum: ["now", "hour", "epoch"] },
      reason: str,
    }),
  },
];

export type BaseProposal = {
  action: "zip" | "send" | "send_link" | "pay" | "unzip" | "speak" | "knock";
  amount_zc: string;
  to: string | null;
  merchant_id: string | null;
  message: string | null;
  target: string | null;
  hold: "now" | "hour" | "epoch";
  reason: string;
};

const ACTIONS = ["zip", "send", "send_link", "pay", "unzip", "speak", "knock"] as const;
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Checks propose_action's input (the model's tool calls aren't schema-enforced) before a card appears. */
export function parseBaseProposal(input: Record<string, unknown>): { ok: true; proposal: BaseProposal } | { ok: false; error: string } {
  try {
    const action = ACTIONS.find((a) => a === input.action) ?? fail(`action must be one of ${ACTIONS.join(", ")}.`);
    zcAmount(input.amount_zc, "amount_zc");
    const to = optStr(input.to);
    if ((action === "send" || action === "knock") && !to) fail(`${action} needs to (an address).`);
    if (to && !isAddress(to)) fail("to isn't a valid Ethereum address.");
    const merchant = optStr(input.merchant_id);
    if (action === "pay" && !(merchant && /^\d{1,30}$/.test(merchant))) fail("pay needs merchant_id from list_merchants.");
    const message = optStr(input.message);
    if ((action === "speak" || action === "knock") && !message) fail(`${action} needs a message.`);
    const hold = input.hold === "hour" || input.hold === "epoch" ? input.hold : "now";
    return {
      ok: true,
      proposal: { action, amount_zc: String(input.amount_zc).trim(), to, merchant_id: merchant, message, target: optStr(input.target), hold, reason: typeof input.reason === "string" ? input.reason.slice(0, 300) : "" },
    };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/** Read-only tools: they run in the browser straight away and only report. */
export const FEATURE_READ_TOOLS: ToolSpec[] = [
  {
    name: "parked_payouts",
    description:
      "Badge stakes of this person's that are parked or stuck: a stake whose deposit back into the pool failed at unlock (with the amount and why, in plain words), or a returned stake the pool's approver hasn't cleared for over a day. Read only: recovering them happens in the wallet's Parked tab.",
    input_schema: noInput,
  },
];

/** Everything Emerald is offered, in a fixed order. */
export const ALL_TOOLS: ToolSpec[] = [...BASE_TOOLS, ...FEATURE_READ_TOOLS];

export const isFeatureReadTool = (name: string) => FEATURE_READ_TOOLS.some((t) => t.name === name);

export const FEATURE_PROMPT = `- Parked payouts: if a badge stake couldn't go back into the pool at unlock it waits, parked, for its owner. parked_payouts says whether this person has any; you can't move them. Send the person to the Parked tab, where sending it back into the pool is the private choice and sending it to an address links that address to the stake.`;

// ——— validation ———

class Invalid extends Error {}
const fail = (m: string): never => {
  throw new Invalid(m);
};

/** A ZC amount as a plain decimal string ("12", "0.5"); `zero` allows 0. */
export function zcAmount(v: unknown, what: string, zero = false): bigint {
  if (typeof v !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(v.trim())) fail(`${what} must be a ZC amount like "10" or "2.5".`);
  const wei = parseEther((v as string).trim());
  if (wei === 0n && !zero) fail(`${what} must be more than zero.`);
  return wei;
}
