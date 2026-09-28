/**
 * The people of Veridia: characters inspired by Vitalik Buterin's novel *Snowmoon*. This is a fan simulation, not
 * affiliated with the author, and it never portrays real people. Bios stay close to what the book shows and leave
 * the rest to the characters' daily lives.
 *
 * Every character has a wallet, a zip key, a zip address and a Semaphore identity, and lives on zipcoin: they eat,
 * send allowances, burn at doorsteps, post anonymously, run and answer polls. Their lives are real pool traffic, so
 * they are also the cover that lets real users' privacy work.
 */

export type Action = "eat" | "allowance" | "knock" | "speak" | "post" | "poll" | "vote" | "zip" | "rest";

export type Character = {
  id: string;
  name: string;
  city: string;
  bio: string;
  voice: string;
  /** Relative appetite for each action when the scripted mind decides */
  habits: Partial<Record<Action, number>>;
  /** Who they send allowances to / knock at */
  close: string[];
  /** Runs a shop: listed in ZipMerchants with this display name */
  shop?: { name: string; menu: [string, number][] };
  /** Starting ZC (wallet) and share of it kept zipped */
  purse: number;
};

export const CAST: Character[] = [
  {
    id: "gladias",
    name: "Gladias",
    city: "Meldan",
    bio: "Teaching assistant in Meldan who reviews rubrics in his spare time. Thoughtful, a little absent-minded (he once forgot to send himself funds before dinner). Walks through the Kalimar forest paths every evening.",
    voice: "careful, curious, dry humor",
    habits: { eat: 5, post: 3, vote: 3, allowance: 2, zip: 1, rest: 3 },
    close: ["seila", "febric", "hreda"],
    purse: 4000,
  },
  {
    id: "seila",
    name: "Seila",
    city: "Meldan",
    bio: "Gladias's partner. Persuasive, patient, the one people open the door for. Sends the kids money for their expenses and keeps the family's recovery keys tested.",
    voice: "warm, direct, determined",
    habits: { allowance: 5, eat: 3, knock: 2, vote: 3, speak: 1, rest: 2 },
    close: ["febric", "hreda", "gladias", "mov"],
    purse: 6000,
  },
  {
    id: "febric",
    name: "Febric",
    city: "Greater Plum Harbor",
    bio: "A teenager living away from home for now, taking informal math lessons with other kids. Playful; teases Gladias about forgetting his zipcoins.",
    voice: "playful, quick, a bit cheeky",
    habits: { eat: 4, post: 3, speak: 1, rest: 4 },
    close: ["hreda", "seila"],
    purse: 400,
  },
  {
    id: "hreda",
    name: "Hreda",
    city: "Greater Plum Harbor",
    bio: "Febric's sibling. Quiet, observant, saves most of what she is sent.",
    voice: "quiet, observant",
    habits: { zip: 3, eat: 2, rest: 5 },
    close: ["febric", "seila"],
    purse: 300,
  },
  {
    id: "zei",
    name: "Zei",
    city: "Dzego",
    bio: "From Dzego, nine months deep into studying cryptography. Loves food-truck dish Number Ten. Gets anonymous messages from courtyards he once ate at.",
    voice: "excitable, technical, generous with explanations",
    habits: { eat: 4, post: 4, speak: 2, vote: 2, rest: 2 },
    close: ["gladias", "mov"],
    purse: 2500,
  },
  {
    id: "mov",
    name: "Mov",
    city: "Meldan",
    bio: "Seila's companion on hard errands. Impatient: tends to burn zipcoins at a doorstep before anyone has knocked twice. Good at finding people.",
    voice: "terse, impatient, loyal",
    habits: { knock: 5, speak: 2, eat: 2, rest: 2 },
    close: ["seila", "zei"],
    purse: 3000,
  },
  {
    id: "evelor",
    name: "Evelor",
    city: "Freetown",
    bio: "Founder of Silverchat. Believes in publishing proofs of every algorithm change and runs large paid polls to create common knowledge.",
    voice: "measured, strategic, founder-ish",
    habits: { poll: 4, speak: 2, eat: 2, rest: 3 },
    close: ["seila"],
    purse: 20000,
  },
  {
    id: "beautiful-plants",
    name: "Beautiful Plants",
    city: "Sadzu Du",
    bio: "A food court on Len Su street in Sadzu Du. Takes zipcoin with the sales tax, never asks who you are, sometimes burns to reach all its past guests.",
    voice: "friendly shop voice",
    habits: { speak: 1, rest: 8 },
    close: [],
    shop: { name: "Beautiful Plants food court", menu: [["Number Ten with mushrooms", 11], ["tea", 2], ["vegetable rice", 9]] },
    purse: 3000,
  },
  {
    id: "kalimar-kitchen",
    name: "Kalimar Kitchen",
    city: "Meldan",
    bio: "The restaurant at the edge of the Kalimar district where a 10.5 zipcoin order was once made. Tables with a green circle for paying.",
    voice: "friendly shop voice",
    habits: { rest: 9 },
    close: [],
    shop: { name: "Kalimar Kitchen", menu: [["salad", 10.5], ["tea", 1.5], ["stone-oven bread", 4]] },
    purse: 3000,
  },
  {
    id: "hydrafill",
    name: "Hydrafill",
    city: "Freetown",
    bio: "Sells water bottles online (the ads are everywhere). Shipping costs more than the bottle.",
    voice: "salesy",
    habits: { speak: 2, rest: 7 },
    close: [],
    shop: { name: "Hydrafill", menu: [["water bottle + shipping", 5.5]] },
    purse: 3000,
  },
];

export const byId = new Map(CAST.map((c) => [c.id, c]));
export const shops = CAST.filter((c) => c.shop);
