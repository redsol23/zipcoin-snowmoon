/**
 * One moment of the story. The Veridia service tells each one after its own random delay and leaves out anything that
 * could match it to the chain (no hashes, job ids, amounts, shops, items or exact times): `at` is when it was told,
 * `when` roughly when it happened ("this afternoon"). The offline scripted day adds a little invented detail, since
 * nothing there touches a chain.
 */
export type WorldEvent = {
  at: number;
  who: string;
  action: string;
  line: string;
  when?: string;
  detail?: Record<string, unknown>;
};

/** A resident as the service lists them. Their wallets are deliberately not listed: their spends should look like anyone's. */
export type Resident = {
  id: string;
  name: string;
  city: string;
  bio: string;
  shop?: string;
};

/** Actions a courier carries (a proof held a while, then sent), as opposed to a resident's own public wallet call */
const CARRIED = new Set(["eat", "allowance", "knock", "speak", "post", "ask", "vote"]);
export const viaCourier = (action: string) => CARRIED.has(action);

export const services = {
  veridia: process.env.VERIDIA_URL ?? "http://127.0.0.1:8730",
  courier: process.env.COURIER_URL ?? "http://127.0.0.1:8720",
  postman: process.env.POSTMAN_URL ?? "http://127.0.0.1:8710",
};

/** The four places the story happens, laid out on the drawn map (viewBox 0 0 400 300). */
export const CITIES: Record<string, { x: number; y: number; note: string }> = {
  Meldan: { x: 120, y: 120, note: "stone houses, the Kalimar paths, the sky bridge" },
  "Sadzu Du": { x: 290, y: 82, note: "food courts on Len Su street" },
  Dzego: { x: 345, y: 178, note: "food trucks, Number Ten" },
  Freetown: { x: 250, y: 230, note: "shelters, tolls, Silverchat" },
  "Greater Plum Harbor": { x: 70, y: 235, note: "full schools, informal lessons" },
};

/**
 * The Veridian calendar, in the form the novel writes dates ("3724 Rainmoon 13"). Only a few month names appear in
 * the book, so the year is split between them; the numbers follow the real calendar so readers can line them up.
 */
const MONTHS = ["Snowmoon", "Snowmoon", "Snowmoon", "Snowmoon", "Rainmoon", "Rainmoon", "Rainmoon", "Rainmoon", "Mistime", "Mistime", "Mistime", "Mistime"];
export function veridianDate(d = new Date()) {
  return `${d.getUTCFullYear() + 1698} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A quiet footnote saying what kind of thing happened on-chain, in plain words (never which transaction). */
export function footnote(e: WorldEvent): string | null {
  switch (e.action) {
    case "eat":
      return "A note was spent at a shop, tax included. The chain saw a payment, not who made it.";
    case "allowance":
      return "Sent inside the pool; the coins never touched a wallet.";
    case "knock":
    case "speak":
      return "Zipcoins burned from a note, not from anyone's wallet.";
    case "post":
    case "ask":
    case "vote":
      return "On-chain, the proof only says some badge holder did it.";
    case "poll":
      return "Paid in the open, from a wallet.";
    case "zip":
      return "Coins went from a wallet into the pool.";
    default:
      return null;
  }
}

/** Which of the three meaningful colors an event carries. */
export function tone(action: string): "pad" | "candle" | "slate" | null {
  if (action === "eat" || action === "allowance" || action === "zip") return "pad";
  if (action === "knock" || action === "speak") return "candle";
  if (action === "poll" || action === "ask" || action === "vote" || action === "post") return "slate";
  return null;
}

/** Said wherever the story is shown live */
export const BEHIND = "The story runs a little behind the chain, and leaves out the details, so it can't be matched to a transaction.";
