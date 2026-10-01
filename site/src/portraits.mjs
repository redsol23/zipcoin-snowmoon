// Portraits of Veridia's residents and shops: flat shapes in the site's winter palette, one recognisable detail each,
// drawn from their public bios. Fictional characters inspired by Snowmoon; none depicts a real person.
// Every fill is a CSS class (pt-*), so the page's stylesheet colours them.

const W = 120;

// shared pieces ------------------------------------------------------------------------------------------------

const shoulders = (cls, extra = "") => `<path class="${cls}" d="M14 122c4-28 22-40 46-40s42 12 46 40Z"/>${extra}`;
const neck = `<rect class="pt-skin-2" x="53" y="66" width="14" height="18" rx="5"/>`;
const head = (cx = 60, cy = 50, r = 18) => `<circle class="pt-skin" cx="${cx}" cy="${cy}" r="${r}"/>`;
const eyes = (y = 52, dx = 6.5, cx = 60) => `<circle class="pt-ink" cx="${cx - dx}" cy="${y}" r="1.9"/><circle class="pt-ink" cx="${cx + dx}" cy="${y}" r="1.9"/>`;
const smile = (y = 59, cx = 60) => `<path class="pt-line" d="M${cx - 4} ${y}q4 3 8 0"/>`;
const flat = (y = 60, cx = 60) => `<path class="pt-line" d="M${cx - 3.5} ${y}h7"/>`;

// the people ---------------------------------------------------------------------------------------------------

const PEOPLE = {
  // teaching assistant, thoughtful and absent-minded; walks the Kalimar forest paths every evening
  gladias: () =>
    `<path class="pt-pine-far" d="M18 70 30 30 42 70Z"/><path class="pt-pine-near" d="M84 74 98 26 112 74Z"/>` +
    shoulders("pt-slate", `<path class="pt-pad" d="M40 86c8 7 32 7 40 0l4 9c-10 8-38 8-48 0Z"/><rect class="pt-pad" x="68" y="88" width="9" height="22" rx="3"/>`) +
    neck + head() +
    `<path class="pt-hair-dark" d="M42 46c0-14 10-21 19-21 11 0 18 8 17 19-4-6-11-9-19-8-7 1-12 4-17 10Z"/>` +
    `<circle class="pt-glasses" cx="53.5" cy="52" r="5"/><circle class="pt-glasses" cx="66.5" cy="52" r="5"/><path class="pt-glasses" d="M58.5 52h3"/>` +
    eyes(52) + flat(61),

  // persuasive, patient, the one people open the door for; sends the kids money for their expenses
  seila: () =>
    `<rect class="pt-door-frame" x="76" y="20" width="36" height="104" rx="4"/><rect class="pt-door-glow" x="82" y="26" width="24" height="98" rx="3"/>` +
    `<path class="pt-hair-brown" d="M38 54c-2-20 10-32 22-32s24 12 22 32l3 34H35Z"/>` +
    shoulders("pt-pad-deep", `<path class="pt-candle" d="M42 84c8 6 28 6 36 0l3 7c-10 7-32 7-42 0Z"/>`) +
    neck + head() +
    `<path class="pt-hair-brown" d="M42 48c1-13 9-20 18-20s17 7 18 20c-6-7-12-10-18-10s-12 3-18 10Z"/>` +
    eyes(52) + smile(59) +
    `<g transform="rotate(-8 34 100)"><rect class="pt-paper" x="22" y="92" width="24" height="16" rx="1.5"/><path class="pt-edge" d="M22 92l12 9 12-9"/><circle class="pt-candle" cx="34" cy="101" r="2.2"/></g>`,

  // a teenager taking informal math lessons with other kids; playful
  febric: () =>
    `<rect class="pt-board" x="70" y="22" width="44" height="32" rx="3"/><path class="pt-chalk" d="M77 34h8M81 30v8M90 38l6-6M90 32l6 6M101 34h8M78 46c6-6 12 6 18 0s10-4 14 0"/>` +
    shoulders("pt-slate", `<path class="pt-slate-deep" d="M46 88h28l-4 16H50Z"/>`) +
    neck + head(58, 54, 17) +
    `<path class="pt-pad" d="M40 50c0-14 8-22 18-22s18 8 18 22Z"/><rect class="pt-pad-deep" x="38" y="46" width="40" height="7" rx="3.5"/><circle class="pt-candle" cx="58" cy="26" r="5"/>` +
    eyes(57, 6, 58) + `<path class="pt-line" d="M53 63q5 4 10 0"/>` +
    `<rect class="pt-chalkstick" x="24" y="94" width="14" height="4" rx="2" transform="rotate(-30 31 96)"/>`,

  // Febric's sibling; quiet, observant, saves most of what she is sent
  hreda: () =>
    shoulders("pt-lichen", `<path class="pt-candle" d="M44 84c6 5 26 5 32 0l2 6c-8 6-28 6-36 0Z"/>`) +
    neck +
    `<path class="pt-hair-dark" d="M40 56c-2-19 8-30 20-30s22 11 20 30l-2 12H42Z"/>` +
    head() +
    `<path class="pt-hair-dark" d="M42 50c2-12 9-18 18-18s16 6 18 18c-4-2-10-8-18-8s-14 6-18 8Z"/>` +
    eyes(53, 6.5) + flat(61) +
    // a small savings jar with a green ring on it
    `<rect class="pt-jar" x="74" y="92" width="22" height="24" rx="5"/><rect class="pt-jar-lid" x="76" y="88" width="18" height="5" rx="2"/><circle class="pt-ring" cx="85" cy="104" r="5"/>`,

  // from Dzego, deep into studying cryptography; loves food-truck dish Number Ten
  zei: () =>
    shoulders("pt-candle", `<path class="pt-candle-deep" d="M52 82h16v38H52Z"/>`) +
    neck + head() +
    `<path class="pt-hair-dark" d="M40 50c-3-6 1-14 7-15 1-7 9-11 14-8 5-4 13-1 15 5 7 1 9 9 6 15-2-5-7-8-12-7-6-5-14-5-20 0-4-1-8 3-10 10Z"/>` +
    `<path class="pt-phones" d="M40 54c0-15 9-24 20-24s20 9 20 24"/><rect class="pt-slate" x="36" y="50" width="7" height="12" rx="3"/><rect class="pt-slate" x="77" y="50" width="7" height="12" rx="3"/>` +
    eyes(53) + smile(60) +
    // a steaming bowl: Number Ten
    `<path class="pt-steam" d="M26 82c-3-4 3-6 0-10M34 82c-3-4 3-6 0-10"/><path class="pt-bowl" d="M18 86h26c0 10-6 16-13 16s-13-6-13-16Z"/><text class="pt-num" x="31" y="97" text-anchor="middle">10</text>`,

  // Seila's companion on hard errands; impatient, burns at a doorstep before anyone has knocked twice
  mov: () =>
    `<rect class="pt-door-frame" x="8" y="24" width="30" height="100" rx="4"/><circle class="pt-candle" cx="31" cy="76" r="2.5"/>` +
    shoulders("pt-pine-coat") +
    `<path class="pt-pine-coat" d="M36 62c-2-24 10-38 24-38s26 14 24 38l-2 22H38Z"/>` +
    neck + head(60, 54, 17) +
    `<path class="pt-ink-soft" d="M50 47l8 3M70 47l-8 3"/>` + eyes(54, 6) + `<path class="pt-line" d="M55 63q5-3 10 0"/>` +
    // mid-burn: a small flame in an outstretched hand
    `<circle class="pt-skin" cx="94" cy="98" r="6"/><path class="pt-flame" d="M94 92c-6-5-5-12 0-18 1 5 7 6 7 11s-3 7-7 7Z"/><path class="pt-flame-core" d="M94 91c-2-2-2-5 0-8 1 3 3 4 3 5s-1 3-3 3Z"/>`,

  // a founder who publishes proofs of every algorithm change and runs large paid polls
  evelor: () =>
    shoulders("pt-slate-deep", `<path class="pt-paper" d="M52 82l8 14 8-14Z"/><path class="pt-slate" d="M44 86l16 30 16-30 6 3-22 33-22-33Z"/>`) +
    neck + head() +
    `<path class="pt-hair-grey" d="M42 50c-1-15 8-24 19-24 10 0 19 7 18 20-9 0-17-4-22-10-2 7-8 11-15 14Z"/>` +
    eyes(53) + flat(61) +
    // a paid poll, as a card of bars
    `<rect class="pt-paper" x="80" y="76" width="30" height="36" rx="3"/><rect class="pt-pad" x="85" y="98" width="5" height="9"/><rect class="pt-slate" x="93" y="88" width="5" height="19"/><rect class="pt-candle" x="101" y="94" width="5" height="13"/><path class="pt-edge" d="M84 83h22"/>`,
};

// the shops ----------------------------------------------------------------------------------------------------

const SHOPS = {
  // a food court on Len Su street; takes zipcoin with the sales tax and never asks who you are
  "beautiful-plants": () =>
    `<rect class="pt-stone" x="18" y="40" width="84" height="82"/>` +
    `<path class="pt-pad" d="M14 34h92v10H14Z"/><path class="pt-pad" d="M14 44h12l-6 9ZM26 44h12l-6 9ZM38 44h12l-6 9ZM50 44h12l-6 9ZM62 44h12l-6 9ZM74 44h12l-6 9ZM86 44h12l-6 9ZM98 44h8l-4 9Z"/>` +
    `<rect class="pt-door-glow" x="46" y="66" width="28" height="56" rx="14"/>` +
    `<path class="pt-steam" d="M58 80c-3-4 3-6 0-10M64 80c-3-4 3-6 0-10"/><path class="pt-bowl" d="M50 84h22c0 8-5 12-11 12s-11-4-11-12Z"/>` +
    `<path class="pt-leaf" d="M26 96c-6-10 2-18 8-18 0 8-2 14-8 18Z"/><path class="pt-leaf" d="M30 98c0-10 10-14 14-10-4 6-8 10-14 10Z"/><rect class="pt-pot" x="24" y="98" width="16" height="12" rx="2"/>` +
    `<path class="pt-leaf" d="M94 96c6-10-2-18-8-18 0 8 2 14 8 18Z"/><rect class="pt-pot" x="80" y="98" width="16" height="12" rx="2"/>`,

  // the restaurant at the edge of the Kalimar district; tables with a green circle for paying
  "kalimar-kitchen": () =>
    `<path class="pt-pine-far" d="M4 90 16 50 28 90Z"/><path class="pt-pine-near" d="M96 92 108 46 120 92Z"/>` +
    `<rect class="pt-stone" x="24" y="46" width="72" height="76"/><path class="pt-brick" d="M24 62h72M24 78h72M24 94h72M44 46v16M76 46v16M60 62v16M40 78v16M80 78v16"/>` +
    `<path class="pt-roof" d="M18 48 60 18l42 30Z"/><path class="pt-snow" d="M18 48 60 18l42 30-6-1L60 24 24 47Z"/>` +
    `<rect class="pt-door-glow" x="50" y="84" width="20" height="38" rx="10"/><rect class="pt-window" x="32" y="84" width="12" height="12" rx="1"/><rect class="pt-window" x="76" y="84" width="12" height="12" rx="1"/>` +
    // a table with the green circle
    `<rect class="pt-table" x="34" y="108" width="52" height="5" rx="2"/><circle class="pt-ring" cx="60" cy="106" r="4"/>`,

  // sells water bottles online; the ads are everywhere, and shipping costs more than the bottle
  hydrafill: () =>
    `<rect class="pt-slate" x="20" y="40" width="80" height="82"/><rect class="pt-snow" x="16" y="34" width="88" height="8" rx="2"/>` +
    `<rect class="pt-ad" x="28" y="50" width="30" height="40" rx="3"/><path class="pt-water" d="M43 56c-6 8-9 13-9 18a9 9 0 0 0 18 0c0-5-3-10-9-18Z"/>` +
    `<rect class="pt-bottle" x="70" y="58" width="16" height="36" rx="5"/><rect class="pt-bottle-cap" x="74" y="52" width="8" height="7" rx="2"/><rect class="pt-water" x="72" y="72" width="12" height="20" rx="3"/>` +
    // the parcel (shipping)
    `<rect class="pt-parcel" x="60" y="100" width="30" height="20" rx="2"/><path class="pt-tape" d="M75 100v20M60 108h30"/>` +
    `<rect class="pt-door-glow" x="30" y="98" width="20" height="24" rx="3"/>`,
};

/** The portrait for a resident or shop (see veridia.mjs), as an inline SVG. */
export function portraitSvg(r, cls = "portrait") {
  const draw = (r.shop ? SHOPS : PEOPLE)[r.slug];
  if (!draw) throw new Error(`no portrait for ${r.slug}`);
  const id = `pc-${r.slug}`;
  return `<svg class="${cls}" viewBox="0 0 ${W} ${W}" aria-hidden="true" focusable="false"><defs><clipPath id="${id}"><circle cx="60" cy="60" r="58"/></clipPath></defs><circle class="pt-bg" cx="60" cy="60" r="59"/><g clip-path="url(#${id})">${draw()}</g><circle class="pt-rim" cx="60" cy="60" r="58.5"/></svg>`;
}
