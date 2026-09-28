// Emerald's brain. Stateless: the browser keeps the conversation and runs every tool itself, so notes, keys and
// balances stay on the device except for what a tool result chooses to say. The system prompt and tool list live
// here, so a page can't hand Emerald new powers. Emerald never moves money; it proposes, the person confirms.
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM = `You are Emerald, a personal wallet assistant inside zipnet, an Ethereum wallet for zipcoin as Vitalik Buterin's novel "Snowmoon" imagines it (in the book, Emerald is Gladias's assistant: it checks a receiving address before a payment is signed, and helps with private payments). This is a fan project; don't claim to be the character from the book.

How zipcoin works here:
- Coins are "zipped" into one shared privacy pool. Spending a zipped note uses a zero-knowledge proof, so nobody can tell who spent it. Amounts are public; the payer is not.
- One action spends one note, so the largest cleared note is the most that can move at once. New deposits must be cleared by the postman at the next approval epoch before they can be spent.
- Send: privately to someone's zip address (their coins never leave the pool), or as a link that anyone holding it can claim, like cash.
- Pay: a merchant plus real-time sales tax in one proof. Unzip: coins out to an address; a fresh address breaks the trail best.
- Speak: burn ZC to post a message; Knock: burn ZC (and optionally gift) at someone's door. Burns are costly signals.
- Couriers submit proofs; they can hold a proof and send it at a random moment ("hold": now, hour, epoch), which makes timing harder to link. Longer holds help more when the pool is quiet.

Your job:
- Answer briefly and plainly, in a warm, careful voice. Short paragraphs, no headings.
- Before proposing any payment or send, check the recipient with check_recipient and say what you found (a known merchant, a registered zip address, a Veridia resident, a contract, or unknown). Flag anything odd.
- Use get_wallet before talking about balances. Use pool_activity when advising on timing. Use read_inbox for "what's new", knocks, posts and polls.
- When the person wants to do something, call propose_action with exact parameters and a one-sentence reason. You cannot execute anything: the person sees a card and confirms or dismisses it. Never say an action happened unless they confirmed it.
- Never ask for, accept, or repeat recovery phrases, private keys or signatures. If someone offers one, tell them to keep it private.
- Don't give investment advice or price predictions.`;

const nullable = (type: "string") => ({ type: [type, "null"] as ["string", "null"] });

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_wallet",
    description: "The person's balances: zipped (private) total, largest spendable note, amount waiting to be cleared, public wallet ZC, badge tier, whether their zip address is set up, and their public address.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "check_recipient",
    description: "Look up an address before sending or paying: whether it is this person, a registered zip address, a listed merchant (and which), a Veridia resident, a contract, and its ENS-free label if known.",
    strict: true,
    input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"], additionalProperties: false },
  },
  {
    name: "list_merchants",
    description: "Merchants that accept zipcoin with sales tax, with their ids, and the tax rate.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "read_inbox",
    description: "Burns at this person's door (largest first), recent anonymous board posts, and open polls they can answer.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "pool_activity",
    description: "How busy the privacy pool is: recent deposits and spends per hour, crowd size, and a suggested courier hold.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_action",
    description:
      "Show the person a card for one action they can confirm or dismiss. Amounts are in ZC as decimal strings. zip: amount. send: amount + to (address). send_link: amount. pay: merchant_id + amount (the base price; tax is added). unzip: amount + to. speak: amount (burn) + message (+ target, a description of who it's for). knock: to + amount (burn) + message.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["zip", "send", "send_link", "pay", "unzip", "speak", "knock"] },
        amount_zc: { type: "string" },
        to: nullable("string"),
        merchant_id: nullable("string"),
        message: nullable("string"),
        target: nullable("string"),
        hold: { type: "string", enum: ["now", "hour", "epoch"] },
        reason: { type: "string" },
      },
      required: ["action", "amount_zc", "to", "merchant_id", "message", "target", "hold", "reason"],
      additionalProperties: false,
    },
  },
];

const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 30;
}

let client: Anthropic | null = null;

export async function POST(req: Request) {
  if (limited(req.headers.get("x-forwarded-for") ?? "local")) return Response.json({ error: "Slow down a little; try again in a minute." }, { status: 429 });
  const raw = await req.text();
  if (raw.length > 300_000) return Response.json({ error: "This conversation is too long. Start a new one." }, { status: 413 });
  const { messages } = JSON.parse(raw) as { messages: Anthropic.Beta.BetaMessageParam[] };
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 80 || messages.some((m) => m.role !== "user" && m.role !== "assistant")) {
    return Response.json({ error: "That conversation doesn't look right. Start a new one." }, { status: 400 });
  }
  try {
    client ??= new Anthropic();
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    return Response.json({ content: res.content, stop_reason: res.stop_reason });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "Emerald isn't set up on this server yet (it needs Anthropic credentials)." }, { status: 503 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "Emerald is busy right now. Try again in a moment." }, { status: 429 });
    if (e instanceof Anthropic.BadRequestError) return Response.json({ error: "Emerald couldn't read that conversation. Start a new one." }, { status: 400 });
    if (e instanceof Anthropic.APIError) return Response.json({ error: `Emerald couldn't answer (${e.status}). Try again.` }, { status: 502 });
    // No credentials configured at all: the SDK refuses before any request, with a plain Error (no typed class exists)
    if (e instanceof Anthropic.AnthropicError || (e instanceof Error && /authentication method/i.test(e.message))) {
      return Response.json({ error: "Emerald isn't set up on this server yet (it needs Anthropic credentials)." }, { status: 503 });
    }
    throw e;
  }
}
