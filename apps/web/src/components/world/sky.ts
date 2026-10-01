/**
 * Time of day and weather over Veridia.
 *
 * The day follows the viewer's own clock, so evening in Veridia is evening where you are. The weather changes every
 * few minutes and is the same for everyone looking at the same moment: it is derived from the time, not random.
 */

export type Weather = "clear" | "flurries" | "snow" | "fog" | "blowing";

export type Sky = {
  /** Night's weight, 0 at midday to ~0.55 in the small hours */
  dark: number;
  /** A dawn or dusk wash over the land, if any */
  tint: { rgb: [number, number, number]; a: number } | null;
  phase: "night" | "dawn" | "morning" | "afternoon" | "evening";
  weather: Weather;
  /** Share of the snow pool falling, 0..1 */
  snow: number;
  /** Sideways drift of snow and smoke, world units per second */
  wind: number;
  /** 0..1 */
  fog: number;
  /** A few words for the viewer, e.g. "Evening, light snow" */
  label: string;
};

const WEATHER: { kind: Weather; weight: number; snow: number; wind: number; fog: number; words: string }[] = [
  { kind: "clear", weight: 3, snow: 0.06, wind: 2, fog: 0, words: "clear and cold" },
  { kind: "flurries", weight: 3, snow: 0.35, wind: 5, fog: 0, words: "light snow" },
  { kind: "snow", weight: 2, snow: 0.9, wind: 7, fog: 0.08, words: "snowing" },
  { kind: "fog", weight: 1, snow: 0.12, wind: 1, fog: 0.75, words: "mist over the valleys" },
  { kind: "blowing", weight: 1, snow: 0.6, wind: 34, fog: 0.05, words: "wind and blowing snow" },
];

/** How long a spell of weather lasts, and how long it takes to turn into the next. */
const SPELL = 7 * 60_000;
const TURN = 90_000;

function spell(n: number) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const total = WEATHER.reduce((a, w) => a + w.weight, 0);
  let x = ((h ^ (h >>> 16)) >>> 0) % total;
  for (const w of WEATHER) if ((x -= w.weight) < 0) return w;
  return WEATHER[0];
}

/** How dark it is, from the viewer's local time: 0 at midday, ~0.55 in the small hours. */
export function darkness(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const night = h < 6 || h >= 21 ? 1 : h < 8 ? 1 - (h - 6) / 2 : h >= 18.5 ? (h - 18.5) / 2.5 : 0;
  return Math.max(0, Math.min(1, night)) * 0.55;
}

const bump = (h: number, peak: number, width: number) => Math.max(0, 1 - Math.abs(h - peak) / width);

export function skyAt(d = new Date()): Sky {
  const h = d.getHours() + d.getMinutes() / 60;
  const dark = darkness(d);
  const dawn = bump(h, 7, 1.5);
  const dusk = bump(h, 19, 1.8);
  const tint = dawn > 0 ? { rgb: [242, 186, 140] as [number, number, number], a: dawn * 0.13 } : dusk > 0 ? { rgb: [205, 132, 136] as [number, number, number], a: dusk * 0.14 } : null;
  const phase = h < 5 || h >= 21 ? "night" : h < 8 ? "dawn" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";

  // Blend into the next spell of weather over its last minute and a half
  const ms = d.getTime();
  const n = Math.floor(ms / SPELL);
  const now = spell(n);
  const next = spell(n + 1);
  const into = Math.max(0, (ms % SPELL) - (SPELL - TURN)) / TURN;
  const mix = (a: number, b: number) => a + (b - a) * into;
  const w = into > 0.5 ? next : now;
  return {
    dark,
    tint,
    phase,
    weather: w.kind,
    snow: mix(now.snow, next.snow),
    wind: mix(now.wind, next.wind),
    fog: mix(now.fog, next.fog),
    label: `${phase[0].toUpperCase()}${phase.slice(1)}, ${w.words}`,
  };
}
