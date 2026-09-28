import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";

import { byId, CAST, shops, type Action, type Character } from "./cast";
import { cfg, events } from "./world";

/**
 * How a character decides what to do next. The model only chooses an intent and says a line in character; it never
 * touches keys or builds transactions. act.ts validates the intent and executes it with deterministic code.
 */

export const Intent = z.object({
  action: z.enum(["eat", "allowance", "knock", "speak", "post", "poll", "vote", "zip", "rest"]),
  /** character id for allowance/knock, shop id for eat */
  target: z.string().optional(),
  /** menu item for eat */
  item: z.string().optional(),
  /** ZC for allowance / zip */
  amount: z.number().optional(),
  /** message for knock/speak/post, question for poll */
  message: z.string().optional(),
  /** who a broadcast is for, free text ("someone who ate here last week") */
  audience: z.string().optional(),
  options: z.array(z.string()).optional(),
  pollId: z.string().optional(),
  option: z.number().optional(),
  /** one short in-character sentence narrating the moment, shown in the public Veridia feed */
  line: z.string(),
});
export type Intent = z.infer<typeof Intent>;

export type Situation = {
  zippedZc: number;
  walletZc: number;
  openPolls: { pollId: string; question: string; optionCount: number }[];
};

const SYSTEM = `You are the narrator-mind of one resident of Veridia, a living fan simulation inspired by Vitalik Buterin's novel "Snowmoon" (not affiliated with the author).
Veridia runs on zipcoin: payments are private by default, sales tax is paid in real time, people burn zipcoins to be heard or to knock at someone's door, and anonymous group members can post or answer polls without revealing who they are.
Each turn you pick ONE ordinary thing your character does next and write one short line (under 200 characters) narrating it in their voice.
Keep it everyday and kind: meals, allowances for family, notes to friends, small public messages, polls about city life. No violence, no real-world people or politics, no financial advice, no mention of being an AI.
Only choose actions your character can afford; "rest" is always fine.`;

function scene(c: Character, s: Situation) {
  const recent = events.slice(-12).map((e) => `- ${byId.get(e.who)?.name ?? e.who}: ${e.line}`);
  return [
    `Character: ${c.name} (${c.city}). ${c.bio} Voice: ${c.voice}.`,
    `Zipped (private) balance: ${s.zippedZc.toFixed(1)} ZC. Wallet: ${s.walletZc.toFixed(1)} ZC.`,
    `Close to: ${c.close.map((id) => `${byId.get(id)?.name} [${id}]`).join(", ") || "nobody in particular"}.`,
    `Shops: ${shops.map((x) => `${x.shop!.name} [${x.id}] in ${x.city}: ${x.shop!.menu.map(([n, p]) => `${n} ${p} zc`).join(", ")}`).join(" | ")}`,
    `Open polls: ${s.openPolls.map((p) => `#${p.pollId} "${p.question.split("\n")[0]}" (${p.optionCount} options)`).join(" | ") || "none"}`,
    `Costs: a meal is its price + 1% tax; knocking or speaking burns at least 100 ZC; posting anonymously and voting cost nothing; allowances move zipped ZC to someone close.`,
    `Recent life in Veridia:\n${recent.join("\n") || "- (quiet morning)"}`,
    `Actions: eat{target shop id, item}, allowance{target, amount}, knock{target, message}, speak{message, audience}, post{message}, poll{message question, options}, vote{pollId, option}, zip{amount}, rest.`,
  ].join("\n\n");
}

let client: Anthropic | null = null;
const llmOn = () => {
  if (cfg.useLlm === "off") return false;
  if (!client) {
    try {
      client = new Anthropic();
    } catch {
      return false;
    }
  }
  return true;
};

async function llmDecide(c: Character, s: Situation): Promise<Intent | null> {
  try {
    const res = await client!.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(Intent) },
      system: SYSTEM,
      messages: [{ role: "user", content: scene(c, s) }],
    });
    if (res.stop_reason === "refusal") return null;
    return res.parsed_output ?? null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[veridia] no Anthropic credentials; using the scripted mind");
      cfg.useLlm = "off";
    } else if (e instanceof Anthropic.RateLimitError) {
      console.error("[veridia] rate limited; scripted mind this turn");
    } else if (e instanceof Anthropic.APIError) {
      console.error(`[veridia] API ${e.status}; scripted mind this turn`);
    } else throw e;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the scripted mind: weighted habits and templated lines, used without credentials or when the model declines
// ---------------------------------------------------------------------------------------------------------------

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

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

function scripted(c: Character, s: Situation): Intent {
  const a = weighted(c.habits);
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
      const amount = 10 + Math.floor(Math.random() * 40);
      return { action: "allowance", target: to, amount, line: `${c.name} zips ${amount} ZC to ${byId.get(to)!.name} for the week's expenses.` };
    }
    case "knock": {
      const to = pick(close);
      if (!to) break;
      return { action: "knock", target: to, message: "Open up, it's me. We should talk today.", line: `${c.name} burns zipcoins at ${byId.get(to)!.name}'s door rather than wait for a second knock.` };
    }
    case "speak":
      return { action: "speak", message: "Whoever left tea at the archive node door this morning: thank you.", audience: "someone near the mountain archive", line: `${c.name} burns a little to thank a stranger in public.` };
    case "post":
      return { action: "post", message: pick(["The rubric on forest paths is working; the trees are back.", "Number Ten is better in Dzego, fight me.", "Tested my recovery keys today. Everyone should."]), line: `An anonymous badge holder posts to the tier-1 board.` };
    case "poll": {
      const [q, options] = pick(POLLS);
      return { action: "poll", message: q, options, line: `${c.name} pays to ask Veridia: "${q}"` };
    }
    case "vote": {
      const p = s.openPolls[0];
      if (!p) break;
      return { action: "vote", pollId: p.pollId, option: Math.floor(Math.random() * p.optionCount), line: `Someone with a badge answers poll #${p.pollId}.` };
    }
    case "zip":
      if (s.walletZc > 20) return { action: "zip", amount: Math.floor(s.walletZc / 3), line: `${c.name} zips some savings; the coins disappear into the crowd.` };
  }
  return { action: "rest", line: `${c.name} ${pick(["walks the Kalimar paths", "reads by the window", "naps", "plays a game on the hand device"])}.` };
}

export async function decide(c: Character, s: Situation): Promise<{ intent: Intent; by: "model" | "script" }> {
  if (llmOn()) {
    const i = await llmDecide(c, s);
    if (i) return { intent: i, by: "model" };
  }
  return { intent: scripted(c, s), by: "script" };
}

export const castIds = CAST.map((c) => c.id);
