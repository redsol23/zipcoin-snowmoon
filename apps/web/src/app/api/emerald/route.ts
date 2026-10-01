// Emerald's brain. Stateless: the browser keeps the conversation and runs every tool itself, so notes, keys and
// balances stay on the device except for what a tool result chooses to say. The system prompt and tool list live
// on the server, so a page can't hand Emerald new powers. Emerald never moves money; it proposes, the person confirms.
// The model is DeepSeek (OpenAI-compatible chat completions); access is gated to ZC holders (lib/emerald/gate).
import { costUsd, emeraldCap, estimatePromptTokens, pricesFor, restingMessage, sessionLimited, tokensOf } from "@/lib/emerald/budget";
import { accessOptions, authorize, sessionKey } from "@/lib/emerald/gate";
import { chat, ChatError, MAX_TOKENS, modelName, type ChatMessage } from "@/lib/emerald/deepseek";
import { gateDeps, GateUnavailable } from "@/lib/emerald/server";
import { ALL_TOOLS, FEATURE_PROMPT } from "@/lib/emerald/tools";

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
- Before proposing any payment or send, check the recipient with check_recipient and say what you found (a known merchant, a registered zip address, a contract, or unknown). Flag anything odd.
- Use get_wallet before talking about balances. Use pool_activity when advising on timing. Use read_inbox for "what's new", knocks, posts and polls.
- When the person wants to do something, call propose_action with exact parameters and a one-sentence reason. You cannot execute anything: the person sees a card and confirms or dismisses it. Never say an action happened unless they confirmed it.
- Never ask for, accept, or repeat recovery phrases, private keys or signatures. If someone offers one, tell them to keep it private.
- Don't give investment advice or price predictions.

${FEATURE_PROMPT}`;

const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 30;
}

/** The browser's history, checked for shape: only user, assistant and tool turns, as the OpenAI format has them. */
function parseMessages(raw: string): ChatMessage[] | null {
  let j: { messages?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const ms = j.messages;
  if (!Array.isArray(ms) || ms.length === 0 || ms.length > 200) return null;
  const ok = ms.every((m) => {
    if (!m || typeof m !== "object") return false;
    const r = (m as { role?: unknown }).role;
    if (r === "user") return typeof m.content === "string";
    if (r === "tool") return typeof m.tool_call_id === "string" && typeof m.content === "string";
    if (r === "assistant") return (typeof m.content === "string" || m.content === null) && (m.tool_calls === undefined || Array.isArray(m.tool_calls));
    return false;
  });
  return ok && (ms[0] as ChatMessage).role === "user" ? (ms as ChatMessage[]) : null;
}

/** What the gate accepts, for the wallet's sign-in panel; `resting` (unix sec) when today's model budget is spent. */
export async function GET(req: Request) {
  try {
    const d = await gateDeps();
    const w = worstCase(0);
    const r = emeraldCap().reserve(w.usd, w.tokens);
    if (r.ok) emeraldCap().release(r.r);
    return Response.json({ ...accessOptions(d, "How to use Emerald."), resting: r.ok ? null : r.until });
  } catch (e) {
    if (e instanceof GateUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}

const TOOLS_CHARS = JSON.stringify(ALL_TOOLS).length;

/** The most a call with this much conversation can cost: its prompt, estimated generously, all uncached, plus a full answer */
function worstCase(conversationChars: number) {
  const prompt = estimatePromptTokens(SYSTEM.length + TOOLS_CHARS + conversationChars);
  return { usd: costUsd({ prompt_cache_miss_tokens: prompt, completion_tokens: MAX_TOKENS }, pricesFor(modelName(), process.env)), tokens: prompt + MAX_TOKENS };
}

/** Emerald's answer while the day's budget is spent. */
function resting(until: number) {
  return Response.json({ message: { role: "assistant", content: restingMessage(until) }, finish_reason: "stop", resting: until });
}

export async function POST(req: Request) {
  if (limited(req.headers.get("x-forwarded-for") ?? "local")) return Response.json({ error: "Slow down a little; try again in a minute." }, { status: 429 });
  const raw = await req.text();
  if (raw.length > 300_000) return Response.json({ error: "This conversation is too long. Start a new one." }, { status: 413 });
  const messages = parseMessages(raw);
  if (!messages) return Response.json({ error: "That conversation doesn't look right. Start a new one." }, { status: 400 });
  // Checked before the gate: without a model there is nothing to sign in to
  if (!process.env.DEEPSEEK_API_KEY) return Response.json({ error: "Emerald isn't set up on this server yet (it needs a DeepSeek API key)." }, { status: 503 });

  let d;
  try {
    d = await gateDeps();
  } catch (e) {
    if (e instanceof GateUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }

  // Per-session limits and the daily budget are checked before the gate
  const session = sessionKey(d, req.headers.get("authorization"), d.now());
  if (session && sessionLimited(session)) return Response.json({ error: "You're sending messages faster than Emerald can take them. Wait a minute and try again." }, { status: 429 });
  const w = worstCase(raw.length);
  const reserved = emeraldCap().reserve(w.usd, w.tokens);
  if (!reserved.ok) return resting(reserved.until);

  const auth = authorize(d, { authorization: req.headers.get("authorization") });
  if (!auth.ok) {
    emeraldCap().release(reserved.r);
    return Response.json(auth.body, { status: auth.status });
  }

  try {
    const res = await chat({ system: SYSTEM, messages, tools: ALL_TOOLS });
    // The real cost from DeepSeek's usage fields; without them, the reserved worst case counts
    const prices = pricesFor(modelName(), process.env);
    emeraldCap().settle(reserved.r, res.usage ? costUsd(res.usage, prices) : w.usd, res.usage ? tokensOf(res.usage) : w.tokens);
    // Only the fields the next request needs; reasoning_content must go back to DeepSeek with the tool history
    const m = res.message;
    const message = { role: "assistant" as const, content: m.content ?? null, ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}), ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
    return Response.json({ message, finish_reason: res.finish_reason });
  } catch (e) {
    emeraldCap().release(reserved.r);
    if (e instanceof ChatError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
