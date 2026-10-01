import { z } from "zod/v4";

import { byId, CAST, shops, type Action, type Character } from "./cast";
import { chatJson, deepseekKey, LlmError, NoKey } from "./deepseek";
import { cfg, events } from "./world";

/**
 * How a character decides what to do next. The model only chooses an intent and says a line in character; it never
 * touches keys or builds transactions. act.ts validates the intent and executes it with deterministic code.
 */

export const ACTIONS = [
  "eat",
  "allowance",
  "knock",
  "speak",
  "message",
  "post",
  "poll",
  "ask",
  "vote",
  "zip",
  "rest",
] as const satisfies readonly Action[];

export const Intent = z.object({
  action: z.enum(ACTIONS),
  /** character id for allowance/knock/message, shop id for eat */
  target: z.string().optional(),
  /** menu item for eat */
  item: z.string().optional(),
  /** ZC for allowance / zip */
  amount: z.number().optional(),
  /** message for knock/speak/message/post, question for poll/ask */
  message: z.string().optional(),
  /** who a broadcast is for, free text ("someone who ate here last week") */
  audience: z.string().optional(),
  /** options for poll/ask */
  options: z.array(z.string()).optional(),
  pollId: z.string().optional(),
  /** poll option to vote on */
  option: z.number().optional(),
  /** one short in-character sentence narrating the moment, shown in the public Veridia feed */
  line: z.string(),
});
export type Intent = z.infer<typeof Intent>;

export type Situation = {
  zippedZc: number;
  walletZc: number;
  badge: boolean;
  openPolls: { pollId: string; question: string; optionCount: number }[];
  /** Burn it takes to reach each close person (the broadcast floor) */
  prices: Record<string, number>;
};

const SYSTEM = `You are the narrator-mind of one resident of Veridia, a living fan simulation inspired by Vitalik Buterin's novel "Snowmoon" (not affiliated with the author).
Veridia runs on zipcoin: payments are private by default, sales tax is paid in real time, people burn zipcoins to be heard or to knock at someone's door, and anonymous badge holders can post and answer polls without revealing who they are.
Each turn you pick ONE ordinary thing your character does next and write one short line (under 200 characters) narrating it in their voice.
Keep it everyday and kind: meals, allowances for family, notes to friends, small public messages, polls about city life. No violence, no real-world people or politics, no financial advice, no mention of being an AI.
Only choose actions your character can afford; "rest" is always fine.`;

function scene(c: Character, s: Situation) {
  const recent = events.slice(-12).map((e) => `- ${byId.get(e.who)?.name ?? e.who}: ${e.line}`);
  const mine = new Set<string>([...Object.keys(c.habits), "eat", "rest", "zip"]);
  const ACTION_HELP: Record<Action, string> = {
    eat: "eat{target shop id, item}",
    allowance: "allowance{target, amount}",
    knock: "knock{target, message}",
    speak: "speak{message, audience}",
    message: "message{target, message} (a public note addressed to them)",
    post: "post{message} (anonymous, badge holders)",
    poll: "poll{message question, options} (public, paid from your wallet)",
    ask: "ask{message question, options} (anonymous poll, paid from zipped coins)",
    vote: "vote{pollId, option}",
    zip: "zip{amount}",
    rest: "rest",
  };
  return [
    `Character: ${c.name} (${c.city}). ${c.bio} Voice: ${c.voice}.`,
    `Zipped (private) balance: ${s.zippedZc.toFixed(1)} ZC. Wallet: ${s.walletZc.toFixed(1)} ZC. ${s.badge ? "Holds a tier-1 badge." : "No badge."}`,
    `Close to: ${c.close.map((id) => `${byId.get(id)?.name} [${id}] (reach: ${s.prices[id] ?? 100} ZC)`).join(", ") || "nobody in particular"}.`,
    `Shops: ${shops.map((x) => `${x.shop!.name} [${x.id}] in ${x.city}: ${x.shop!.menu.map(([n, p]) => `${n} ${p} zc`).join(", ")}`).join(" | ")}`,
    `Open polls: ${s.openPolls.map((p) => `#${p.pollId} "${p.question.split("\n")[0]}" (${p.optionCount} options)`).join(" | ") || "none"}`,
    `Costs: a meal is its price + 1% tax; knocking, speaking or messaging burns at least 100 ZC; posting and voting cost nothing; anonymous polls are paid from zipped coins.`,
    `Recent life in Veridia:\n${recent.join("\n") || "- (quiet morning)"}`,
    `Actions you might take: ${[...mine].map((a) => ACTION_HELP[a as Action]).filter(Boolean).join(", ")}.`,
  ].join("\n\n");
}

/** DeepSeek's JSON mode wants the word "json" and an example of the shape in the prompt */
const JSON_RULES = `Answer with a single json object and nothing else, shaped like this example:
{"action": "eat", "target": "kalimar-kitchen", "item": "tea", "line": "Gladias stops at Kalimar Kitchen for a tea before the evening walk."}
Fields: action and line are required; add only the fields that action needs. Ids are strings, option and amounts are numbers.`;

const llmOn = () => cfg.useLlm !== "off" && !!deepseekKey();

async function llmDecide(c: Character, s: Situation): Promise<Intent | null> {
  try {
    const raw = await chatJson({ system: `${SYSTEM}\n\n${JSON_RULES}`, user: scene(c, s), maxTokens: 600, model: cfg.model });
    const parsed = Intent.safeParse(raw);
    if (!parsed.success) {
      console.error("[veridia] the model's answer didn't fit the intent shape; scripted mind this turn");
      return null;
    }
    return parsed.data;
  } catch (e) {
    if (e instanceof NoKey || (e instanceof LlmError && (e.status === 401 || e.status === 402))) {
      console.error(`[veridia] DeepSeek unavailable (${e instanceof LlmError ? `HTTP ${e.status}` : "no key"}); using the scripted mind`);
      cfg.useLlm = "off";
    } else if (e instanceof LlmError && e.status === 429) {
      console.error("[veridia] rate limited; scripted mind this turn");
    } else {
      // Only the error class or status: a parse error's message can quote the model's output
      console.error(`[veridia] model call failed (${e instanceof LlmError ? e.message : (e as Error).name}); scripted mind this turn`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the scripted mind: weighted habits and templated lines, used without credentials or when the model declines
// ---------------------------------------------------------------------------------------------------------------

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

function weighted(h: Partial<Record<Action, number>>): Action {
  const entries = Object.entries(h) as [Action, number][];
  let r = Math.random() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [a, w] of entries) if ((r -= w) <= 0) return a;
  return "rest";
}

const POLLS: [string, string[]][] = [
  ["Should the Kalimar forest paths get more lanterns?", ["yes", "no", "only near the sky bridge"]],
  ["Which food court should host the harvest fair?", ["Beautiful Plants", "Kalimar Kitchen", "both"]],
  ["How long should algorithm changes wait before taking effect?", ["7 days", "20 days", "60 days"]],
];

/** Questions people ask anonymously: the kind you'd rather not put your name to */
const ASKS: [string, string[]][] = [
  ["Honestly: have you tested your recovery keys this year?", ["yes", "no", "what recovery keys"]],
  ["Would you pay a little more tax for quieter streets after dark?", ["yes", "no", "only in Meldan"]],
  ["Is Silverchat's feed better since the last algorithm change?", ["better", "worse", "didn't notice"]],
  ["Do you check who knocked before opening the door?", ["always", "sometimes", "never"]],
];

const MESSAGES = [
  "Dinner on Friday? My treat, bring the kids.",
  "Your recovery key shard is safe with me. Tested it today.",
  "Saw your post on the board. You were right about the paths.",
];

function scripted(c: Character, s: Situation): Intent {
  const habits = { ...c.habits };
  const a = weighted(habits);
  const close = c.close.filter((id) => byId.has(id));
  switch (a) {
    case "eat": {
      const shop = pick(shops);
      const [item] = pick(shop.shop!.menu);
      return { action: "eat", target: shop.id, item, line: `${c.name} taps a watch on the green circle at ${shop.shop!.name}: ${item}. Paid, tax included, nobody else the wiser.` };
    }
    case "allowance": {
      const to = pick(close.filter((id) => !byId.get(id)!.shop));
      if (!to) break;
      const amount = between(10, 49);
      return { action: "allowance", target: to, amount, line: `${c.name} zips ${amount} ZC to ${byId.get(to)!.name} for the week's expenses.` };
    }
    case "knock": {
      const to = pick(close);
      if (!to) break;
      return { action: "knock", target: to, message: "Open up, it's me. We should talk today.", line: `${c.name} burns zipcoins at ${byId.get(to)!.name}'s door rather than wait for a second knock.` };
    }
    case "message": {
      const to = pick(close.filter((id) => !byId.get(id)!.shop));
      if (!to) break;
      return {
        action: "message",
        target: to,
        message: pick(MESSAGES),
        line: `${c.name} burns ${s.prices[to] ?? 100} ZC and change to send ${byId.get(to)!.name} a note in public.`,
      };
    }
    case "speak":
      return { action: "speak", message: "Whoever left tea at the archive node door this morning: thank you.", audience: "someone near the mountain archive", line: `${c.name} burns a little to thank a stranger in public.` };
    case "post":
      return { action: "post", message: pick(["The rubric on forest paths is working; the trees are back.", "Number Ten is better in Dzego, fight me.", "Tested my recovery keys today. Everyone should."]), line: `An anonymous badge holder posts to the tier-1 board.` };
    case "poll": {
      const [q, options] = pick(POLLS);
      return { action: "poll", message: q, options, line: `${c.name} pays to ask Veridia: "${q}"` };
    }
    case "ask": {
      const [q, options] = pick(ASKS);
      return { action: "ask", message: q, options, line: `Someone burns zipped coins to ask the badge holders: "${q}"` };
    }
    case "vote": {
      const p = pick(s.openPolls);
      if (!p) break;
      return { action: "vote", pollId: p.pollId, option: Math.floor(Math.random() * p.optionCount), line: `Someone with a badge answers poll #${p.pollId}.` };
    }
    case "zip":
      if (s.walletZc > 20) return { action: "zip", amount: Math.floor(s.walletZc / 3), line: `${c.name} zips some savings; the coins disappear into the crowd.` };
  }
  return idle(c);
}

/** A line that touches no chain: resting, or anything else once the day's gas budget is spent */
export function idle(c: Character): Intent {
  return {
    action: "rest",
    line: `${c.name} ${pick(["walks the Kalimar paths", "reads by the window", "naps", "plays a game on the hand device", "chats with a neighbour over the fence", "writes in a notebook, by hand", "waters the plants on the balcony"])}.`,
  };
}

export async function decide(c: Character, s: Situation): Promise<{ intent: Intent; by: "model" | "script" }> {
  if (llmOn()) {
    const i = await llmDecide(c, s);
    if (i) return { intent: i, by: "model" };
  }
  return { intent: scripted(c, s), by: "script" };
}

export const castIds = CAST.map((c) => c.id);
