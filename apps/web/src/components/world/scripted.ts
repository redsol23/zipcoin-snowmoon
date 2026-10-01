/**
 * A scripted day for when the story service is offline (no chain, no couriers, no model): the same public cast and
 * the same kind of everyday moments the Veridia service's scripted mind produces, played locally so the world is
 * never empty. Nothing here touches a chain; the world says so while it plays.
 *
 * The lines stay ordinary and kind (meals, allowances, notes, polls about city life) and never talk about prices
 * going up or down.
 */
import type { Resident, WorldEvent } from "@/lib/veridia";

type Habit = "eat" | "allowance" | "knock" | "speak" | "post" | "poll" | "vote" | "zip" | "rest";

type Offline = Resident & { habits: Partial<Record<Habit, number>>; close: string[] };

const r = (id: string, name: string, city: string, bio: string, habits: Offline["habits"], close: string[], shop?: string): Offline => ({
  id,
  name,
  city,
  bio,
  shop,
  habits,
  close,
});

/** The public cast, as the Veridia service lists it (names, cities, bios; never wallets). */
export const OFFLINE_CAST: Offline[] = [
  r(
    "gladias",
    "Gladias",
    "Meldan",
    "Teaching assistant in Meldan who reviews rubrics in his spare time. Thoughtful, a little absent-minded. Walks through the Kalimar forest paths every evening.",
    { eat: 5, post: 3, vote: 3, allowance: 2, zip: 1, rest: 3 },
    ["seila", "febric", "hreda"],
  ),
  r(
    "seila",
    "Seila",
    "Meldan",
    "Gladias's partner. Persuasive, patient, the one people open the door for. Sends the kids money for their expenses and keeps the family's recovery keys tested.",
    { allowance: 5, eat: 3, knock: 2, vote: 3, speak: 1, rest: 2 },
    ["febric", "hreda", "gladias", "mov"],
  ),
  r(
    "febric",
    "Febric",
    "Greater Plum Harbor",
    "A teenager living away from home for now, taking informal math lessons with other kids. Playful; teases Gladias about forgetting his zipcoins.",
    { eat: 4, post: 3, speak: 1, rest: 4 },
    ["hreda", "seila"],
  ),
  r("hreda", "Hreda", "Greater Plum Harbor", "Febric's sibling. Quiet, observant, saves most of what she is sent.", { zip: 3, eat: 2, rest: 5 }, ["febric", "seila"]),
  r(
    "zei",
    "Zei",
    "Dzego",
    "From Dzego, nine months deep into studying cryptography. Loves food-truck dish Number Ten. Gets anonymous messages from courtyards he once ate at.",
    { eat: 4, post: 4, speak: 2, vote: 2, rest: 2 },
    ["gladias", "mov"],
  ),
  r(
    "mov",
    "Mov",
    "Meldan",
    "Seila's companion on hard errands. Impatient: tends to burn zipcoins at a doorstep before anyone has knocked twice. Good at finding people.",
    { knock: 5, speak: 2, eat: 2, rest: 2 },
    ["seila", "zei"],
  ),
  r(
    "evelor",
    "Evelor",
    "Freetown",
    "Founder of Silverchat. Believes in publishing proofs of every algorithm change and runs large paid polls to create common knowledge.",
    { poll: 4, speak: 2, eat: 2, rest: 3 },
    ["seila"],
  ),
  r(
    "beautiful-plants",
    "Beautiful Plants",
    "Sadzu Du",
    "A food court on Len Su street in Sadzu Du. Takes zipcoin with the sales tax, never asks who you are, sometimes burns to reach all its past guests.",
    { speak: 1, rest: 8 },
    [],
    "Beautiful Plants food court",
  ),
  r(
    "kalimar-kitchen",
    "Kalimar Kitchen",
    "Meldan",
    "The restaurant at the edge of the Kalimar district where a 10.5 zipcoin order was once made. Tables with a green circle for paying.",
    { rest: 9 },
    [],
    "Kalimar Kitchen",
  ),
  r("hydrafill", "Hydrafill", "Freetown", "Sells water bottles online (the ads are everywhere). Shipping costs more than the bottle.", { speak: 2, rest: 7 }, [], "Hydrafill"),
];

const MENUS: Record<string, [string, number][]> = {
  "Beautiful Plants food court": [
    ["Number Ten with mushrooms", 11],
    ["tea", 2],
    ["vegetable rice", 9],
  ],
  "Kalimar Kitchen": [
    ["salad", 10.5],
    ["tea", 1.5],
    ["stone-oven bread", 4],
  ],
  Hydrafill: [["water bottle + shipping", 5.5]],
};

const POLLS: [string, string[]][] = [
  ["Should the Kalimar forest paths get more lanterns?", ["yes", "no", "only near the sky bridge"]],
  ["Which food court should host the harvest fair?", ["Beautiful Plants", "Kalimar Kitchen", "both"]],
  ["How long should algorithm changes wait before taking effect?", ["7 days", "20 days", "60 days"]],
];

const POSTS = ["The rubric on forest paths is working; the trees are back.", "Number Ten is better in Dzego, fight me.", "Tested my recovery keys today. Everyone should."];
const THANKS = ["Whoever left tea at the archive node door this morning: thank you.", "To whoever cleared the snow on the sky bridge: thank you.", "To whoever relit the lantern on the forest path: thank you."];
const RESTS = ["walks the Kalimar paths", "reads by the window", "naps", "plays a game on the hand device"];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function weighted(h: Partial<Record<Habit, number>>): Habit {
  const entries = Object.entries(h) as [Habit, number][];
  let x = Math.random() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [a, w] of entries) if ((x -= w) <= 0) return a;
  return "rest";
}

/** Plays a day in Veridia locally, one moment every few seconds. */
export class ScriptedDay {
  private cast: Offline[];
  private byId: Map<string, Offline>;
  private polls = 0;

  constructor(residents: Resident[]) {
    const known = new Map(OFFLINE_CAST.map((c) => [c.id, c]));
    // Use the live cast when there is one (same ids), with the scripted habits; otherwise the offline cast
    this.cast = residents.length ? residents.map((x) => known.get(x.id) ?? { ...x, habits: { rest: 1 }, close: [] }) : OFFLINE_CAST;
    this.byId = new Map(this.cast.map((c) => [c.id, c]));
  }

  next(at = Date.now()): WorldEvent {
    const people = this.cast.filter((c) => !c.shop);
    const shops = this.cast.filter((c) => c.shop && MENUS[c.shop]);
    // Shops mostly wait for guests; residents carry the day
    const c = Math.random() < 0.08 ? pick(this.cast) : pick(people);
    const ev = (action: string, line: string, detail: Record<string, unknown> = {}): WorldEvent => ({
      at,
      who: c.id,
      action,
      line,
      detail: { ...detail, mind: "scripted-offline" },
    });
    const close = c.close.filter((id) => this.byId.has(id));
    switch (weighted(c.habits)) {
      case "eat": {
        const shop = pick(shops);
        if (!shop) break;
        const [item, price] = pick(MENUS[shop.shop!]);
        return ev("eat", `${c.name} taps a watch on the green circle at ${shop.shop}: ${item}. Paid, tax included, nobody else the wiser.`, {
          shop: shop.shop,
          item,
          base: fmt(price),
          tax: fmt(price / 100),
        });
      }
      case "allowance": {
        const to = pick(close.filter((id) => !this.byId.get(id)!.shop));
        if (!to) break;
        const amount = 10 + Math.floor(Math.random() * 40);
        return ev("allowance", `${c.name} zips ${amount} ZC to ${this.byId.get(to)!.name} for the week's expenses.`, { to: this.byId.get(to)!.name, amount: String(amount) });
      }
      case "knock": {
        const to = pick(close);
        if (!to) break;
        return ev("knock", `${c.name} burns zipcoins at ${this.byId.get(to)!.name}'s door rather than wait for a second knock.`, {
          door: this.byId.get(to)!.name,
          burned: String(100 + Math.floor(Math.random() * 50)),
        });
      }
      case "speak":
        return ev("speak", c.shop ? `${c.name} burns a little to greet everyone who ate here this week.` : `${c.name} burns a little to thank a stranger in public.`, {
          burned: String(100 + Math.floor(Math.random() * 100)),
          target: c.shop ? "past guests" : pick(THANKS),
        });
      case "post":
        return ev("post", "An anonymous badge holder posts to the tier-1 board.", { anonymous: true, text: pick(POSTS) });
      case "poll": {
        const [q, options] = pick(POLLS);
        this.polls++;
        return ev("poll", `${c.name} pays to ask Veridia: "${q}"`, { question: q, options, burned: "100" });
      }
      case "vote":
        if (!this.polls) break;
        return ev("vote", `Someone with a badge answers poll #${this.polls}.`, { pollId: String(this.polls) });
      case "zip":
        return ev("zip", `${c.name} zips some savings; the coins disappear into the crowd.`, { amount: String(20 + Math.floor(Math.random() * 80)) });
    }
    return ev("rest", `${c.name} ${c.shop ? "keeps the lights on for the next guest" : pick(RESTS)}.`, {});
  }
}
