export type WorldEvent = {
  at: number;
  who: string;
  action: string;
  line: string;
  detail?: Record<string, unknown>;
  tx?: string;
  job?: string;
};

export type Resident = {
  id: string;
  name: string;
  city: string;
  bio: string;
  shop?: string;
  wallet: string;
  zipAddress: string;
};

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

const zc = (v: unknown) => `${v} zc`;

/** A quiet footnote saying what actually happened on-chain, in plain words. */
export function footnote(e: WorldEvent): string | null {
  const d = e.detail ?? {};
  if (d.why) return null;
  switch (e.action) {
    case "eat":
      return `${zc(d.base)} + ${zc(d.tax)} tax to ${d.shop}. The chain saw a note spent, not who spent it.`;
    case "allowance":
      return `${zc(d.amount)} sent to ${d.to} inside the pool; the coins never touched a wallet.`;
    case "knock":
      return `${zc(d.burned)} burned at ${d.door}'s door.`;
    case "speak":
      return `${zc(d.burned)} burned to be heard${d.target ? `, for "${d.target}"` : ""}.`;
    case "post":
      return "The story knows who wrote it. On-chain, the proof only says some badge holder did.";
    case "poll":
      return `${zc(d.burned)} burned to ask everyone with a badge.`;
    case "vote":
      return "Answered anonymously; one answer per member.";
    case "zip":
      return `${zc(d.amount)} zipped from a wallet into the pool.`;
    default:
      return null;
  }
}

/** Which of the three meaningful colors an event carries. */
export function tone(action: string): "pad" | "candle" | "slate" | null {
  if (action === "eat" || action === "allowance" || action === "zip") return "pad";
  if (action === "knock" || action === "speak") return "candle";
  if (action === "poll" || action === "vote" || action === "post") return "slate";
  return null;
}
