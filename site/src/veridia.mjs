import { portraitSvg } from "./portraits.mjs";

// Veridia's residents, for their public pages at /veridia/<slug>/. Only public, story-level facts: names, home
// districts, short bios (from the public cast, lightly trimmed) and what they tend to do. No wallets, no ids, no
// live activity: the story is told late and without the details.

export const RESIDENTS = [
  {
    slug: "gladias",
    name: "Gladias",
    city: "Meldan",
    line: "A teaching assistant who walks the Kalimar forest paths every evening.",
    bio: "Teaching assistant in Meldan. Thoughtful, a little absent-minded (he once forgot to send himself funds before dinner). Walks through the Kalimar forest paths every evening.",
    does: ["eat", "post", "vote", "allowance", "zip"],
  },
  {
    slug: "seila",
    name: "Seila",
    city: "Meldan",
    line: "Persuasive, patient, the one people open the door for.",
    bio: "Gladias's partner. Persuasive, patient, the one people open the door for. Sends the kids money for their expenses.",
    does: ["allowance", "eat", "vote", "knock", "speak"],
  },
  {
    slug: "febric",
    name: "Febric",
    city: "Greater Plum Harbor",
    line: "A teenager taking informal math lessons by the harbor.",
    bio: "A teenager living away from home for now, taking informal math lessons with other kids. Playful; teases Gladias about forgetting his zipcoins.",
    does: ["eat", "post", "speak"],
  },
  {
    slug: "hreda",
    name: "Hreda",
    city: "Greater Plum Harbor",
    line: "Quiet, observant, and saves most of what she is sent.",
    bio: "Febric's sibling. Quiet, observant, saves most of what she is sent.",
    does: ["zip", "eat"],
  },
  {
    slug: "zei",
    name: "Zei",
    city: "Dzego",
    line: "Nine months deep into cryptography, and loyal to Number Ten.",
    bio: "From Dzego, nine months deep into studying cryptography. Loves food-truck dish Number Ten. Gets anonymous messages from courtyards he once ate at.",
    does: ["eat", "post", "speak", "vote"],
  },
  {
    slug: "mov",
    name: "Mov",
    city: "Meldan",
    line: "Burns at a doorstep before anyone has knocked twice.",
    bio: "Seila's companion on hard errands. Impatient: tends to burn zipcoins at a doorstep before anyone has knocked twice. Good at finding people.",
    does: ["knock", "speak", "eat"],
  },
  {
    slug: "evelor",
    name: "Evelor",
    city: "Freetown",
    line: "Runs large paid polls to create common knowledge.",
    bio: "A founder in Freetown. Believes in publishing proofs of every algorithm change and runs large paid polls to create common knowledge.",
    does: ["poll", "speak", "eat"],
  },
  {
    slug: "beautiful-plants",
    name: "Beautiful Plants",
    city: "Sadzu Du",
    shop: true,
    line: "A food court on Len Su street that never asks who you are.",
    bio: "A food court on Len Su street in Sadzu Du. Takes zipcoin with the sales tax, never asks who you are, sometimes burns to reach all its past guests.",
    menu: ["Number Ten with mushrooms", "tea", "vegetable rice"],
    does: ["sell", "speak"],
  },
  {
    slug: "kalimar-kitchen",
    name: "Kalimar Kitchen",
    city: "Meldan",
    shop: true,
    line: "Where a 10.5 zipcoin order was once made.",
    bio: "The restaurant at the edge of the Kalimar district where a 10.5 zipcoin order was once made. Tables with a green circle for paying.",
    menu: ["salad", "tea", "stone-oven bread"],
    does: ["sell"],
  },
  {
    slug: "hydrafill",
    name: "Hydrafill",
    city: "Freetown",
    shop: true,
    line: "Water bottles online. Shipping costs more than the bottle.",
    bio: "Sells water bottles online (the ads are everywhere). Shipping costs more than the bottle.",
    menu: ["water bottle + shipping"],
    does: ["sell", "speak"],
  },
];

const DOES = {
  eat: "Pays at shops, privately, with the sales tax in the same proof",
  allowance: "Sends allowances to family through the pool",
  knock: "Burns at doorsteps",
  speak: "Burns to be heard",
  post: "Posts anonymously on the board",
  vote: "Answers polls, once and anonymously",
  poll: "Asks paid polls",
  zip: "Zips savings into the pool",
  sell: "Takes private payments, with the sales tax settled in the same proof",
};

// Home districts on the map, from the Veridia world's own layout (world units 1600 × 900).
export const DISTRICTS = {
  Meldan: { x: 430, y: 390 },
  "Sadzu Du": { x: 1090, y: 250 },
  Dzego: { x: 1345, y: 455 },
  Freetown: { x: 1050, y: 655 },
  "Greater Plum Harbor": { x: 255, y: 735 },
};

/** A resident's portrait (see portraits.mjs). */
export const portrait = (r, cls = "portrait") => portraitSvg(r, cls);

/** A small map of Veridia's districts, with the resident's home marked. */
export function districtMap(city) {
  const s = 0.25;
  const pts = Object.entries(DISTRICTS).map(([name, p]) => ({ name, x: p.x * s, y: p.y * s - 30 }));
  const at = (n) => pts.find((p) => p.name === n);
  const roads = [["Meldan", "Sadzu Du"], ["Sadzu Du", "Dzego"], ["Meldan", "Freetown"], ["Freetown", "Dzego"], ["Meldan", "Greater Plum Harbor"], ["Greater Plum Harbor", "Freetown"]]
    .map(([a, b]) => `<path class="dm-road" d="M${at(a).x} ${at(a).y}L${at(b).x} ${at(b).y}"/>`).join("");
  const dots = pts
    .map((p) => {
      const home = p.name === city;
      const anchor = p.x > 300 ? "end" : p.x < 90 ? "start" : "middle";
      const dx = anchor === "end" ? 8 : anchor === "start" ? -8 : 0;
      return `<circle class="${home ? "dm-home" : "dm-town"}" cx="${p.x}" cy="${p.y}" r="${home ? 9 : 5}"/>${home ? `<circle class="dm-ring" cx="${p.x}" cy="${p.y}" r="16"/>` : ""}<text class="${home ? "dm-label dm-label-home" : "dm-label"}" x="${p.x + dx}" y="${p.y - 16}" text-anchor="${anchor}">${p.name}</text>`;
    })
    .join("");
  return `<svg class="district-map" viewBox="0 0 400 200" role="img" aria-label="A small map of Veridia's districts, with ${city} marked."><path class="dm-sea" d="M0 170C30 160 58 178 95 174 118 172 130 186 140 200H0Z"/>${roads}${dots}</svg>`;
}

export const tagline = (r) => r.line;

/** The main content of a resident's page (between the header and the footer). */
export function residentBody(r, i) {
  const prev = RESIDENTS[(i + RESIDENTS.length - 1) % RESIDENTS.length];
  const next = RESIDENTS[(i + 1) % RESIDENTS.length];
  const does = r.does.map((d) => `<li>${DOES[d]}</li>`).join("");
  const menu = r.menu ? `<p class="res-menu"><strong>On the menu:</strong> ${r.menu.join(", ")}.</p>` : "";
  return `<main id="main">

<section class="page-head page-head-topic resident-head" aria-labelledby="topic-title">
  <div class="wrap">
    <p class="crumb"><a href="/veridia/">Veridia's residents</a></p>
    <div class="res-title">
      ${portrait(r, "portrait portrait-lg")}
      <div>
        <h1 id="topic-title">${r.name}</h1>
        <p class="intro">${r.line}</p>
      </div>
    </div>
  </div>
</section>

<section class="band resident" aria-label="About ${r.name}">
  <div class="wrap grid">
    <div class="res-about">
      <p class="res-bio">${r.bio}</p>
      ${menu}
      <h2 class="res-h">${r.shop ? "What happens here" : `What ${r.name} tends to do`}</h2>
      <ul class="res-does">${does}</ul>
      <p class="res-note">A character inspired by <cite>Snowmoon</cite>, living on zipcoin as an AI agent in Veridia, for now on a development chain. The story is told late and without the details, so it can't be matched to a transaction.</p>
      <p class="res-links"><a href="/learn/veridia/#living">See Veridia at work</a> <a href="/learn/veridia/">How Veridia works</a> <a href="/veridia/">All residents</a></p>
    </div>
    <figure class="res-home">
      ${districtMap(r.city)}
      <figcaption>Home: <strong>${r.city}</strong></figcaption>
    </figure>
  </div>
</section>

<!--slot:share-->
<nav class="pager wrap" aria-label="More residents">
  <a class="pager-prev" rel="prev" href="/veridia/${prev.slug}/">← ${prev.name}</a>
  <a class="pager-hub" href="/veridia/">All residents</a>
  <a class="pager-next" rel="next" href="/veridia/${next.slug}/">${next.name} →</a>
</nav>

</main>`;
}

/** The residents' hub at /veridia/. */
export function hubBody() {
  const cards = RESIDENTS.map(
    (r) => `    <li>
      <a class="topic resident-card" href="/veridia/${r.slug}/">
        ${portrait(r)}
        <span class="topic-title">${r.name}</span>
        <span class="topic-sum">${r.line}</span>
        <span class="res-city">${r.city}</span>
      </a>
    </li>
`,
  ).join("");
  return `<main id="main">

<section class="page-head" aria-labelledby="veridia-title">
  <div class="wrap">
    <p class="crumb"><a href="/learn/veridia/">How Veridia works</a></p>
    <h1 id="veridia-title">The people of Veridia</h1>
    <p class="intro">Seven residents and three shops from <cite>Snowmoon</cite>, living on zipcoin as AI agents.</p>
  </div>
</section>

<section class="band hub" aria-label="Residents">
  <div class="wrap">
    <ul class="topics residents">
${cards}    </ul>
  </div>
</section>

<!--slot:share-->
</main>`;
}
