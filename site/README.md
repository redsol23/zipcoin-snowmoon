# zipcoin.org

The public website: one static page (plus a 404) about zipcoin, Snowmoon and Veridia. Plain HTML, CSS and a
3 KB script; no framework, no runtime dependencies, and no third-party requests of any kind (fonts are
self-hosted, there are no analytics).

## Deploy

`site/public/` is the finished site and is committed, so it can be uploaded as-is.

Cloudflare Pages settings:

- Build command: none (or `node site/build.mjs`, which regenerates the same files)
- Build output directory: `site/public`

`site/public/_headers` sets the security headers (a strict CSP with no inline scripts or styles, HSTS with
preload, `nosniff`, `frame-ancestors 'none'`, COOP and a Permissions-Policy that turns off everything the page
doesn't use). `site/public/.well-known/security.txt` expires on 2027-09-28; bump it before then.

## Edit

Edit the sources in `site/src/`, then rebuild:

```bash
node site/build.mjs            # writes site/public (Node 18+, no install step)
node site/tools/serve.mjs      # preview on http://localhost:4317/ with the _headers CSP enforced
```

- `src/index.html`: the short homepage (hero, three big points and the city, what makes this different, the status
  strip). `src/learn/index.html`: the `/learn/` hub, one card per topic. `src/learn/<topic>/index.html`: the short
  topic pages (privacy, couriers, veridia, agents, novel, faq), each with a pager; their order lives in `build.mjs`.
  `src/404.html`: the not-found page. Old `/learn/#anchor` links are forwarded by `main.js`.
- `src/partials/`: the header and footer shared by both pages (`<!--part:header-->`, `<!--part:footer-->`).
  `<!--art:name-->` marks where an illustration goes.
- `src/art.mjs`: the illustrations (hero valley, moon, the four zipping steps, a courier, the pool, the Veridia
  map), drawn as inline SVG in the style of `apps/web/src/components/world/`. Every fill is a CSS class, so
  `styles.css` turns day into night for dark mode.
- The only motion is the hero's snowfall in `src/static/main.js`: one canvas, low device-pixel ratio, fewer flakes on
  phones, paused off screen and in hidden tabs, still under `prefers-reduced-motion`. `main.js` also runs the phone
  menu (a `<details>`, so it works without the script), the copy buttons and the forwarding of old `/learn/#anchor`
  links. Without the script every word and picture is still on the page. External links get
  `rel="noreferrer noopener"` at build time.
- `node site/tools/check-links.mjs` checks every internal link, fragment, canonical and OG URL, the sitemap and
  `robots.txt` in `site/public`.
- `src/static/img/`: the living-map screenshot shown in the Veridia section on desktop (the illustrated map is used
  below 840px). `python site/tools/living-map.py <screenshot.png>` crops a 1440 × 1000 capture of the Veridia page to
  its map panel and writes AVIF, WebP and PNG at 1087 and 720 pixels wide. Check any new capture first: its feed and
  cards must only show public actions.
- `src/static/`: copied into `public/` unchanged (stylesheet, script, fonts, icons, robots, sitemap, headers).
- Fonts: Newsreader and IBM Plex Sans (SIL Open Font License, licenses next to the files), subset to Latin
  and cut to static instances so the page loads about 125 KB of fonts in total.

## Veridia's residents

`src/veridia.mjs` holds the residents' public facts (name, home district, a short bio, what they tend to do) and
draws their portraits and district maps. The build generates `/veridia/` and `/veridia/<slug>/` from it, with the
shared head in `src/partials/head.html`. No wallets, ids or live activity go on these pages.

## Preview cards

Every page gets its own 1200 × 630 card at `/og/<name>.png` (`home`, `learn`, `learn-tax`, `veridia-mov`, ...),
referenced as absolute `og:image` and `twitter:image` URLs with `summary_large_image`. The build writes each card as
HTML to `.local/site/cards/` (from `src/cards.mjs`: the page's title, a line, its drawing and the zipcoin mark,
always in the light theme). To render them after changing a page's title, line or art:

```bash
node site/build.mjs                   # writes the card pages
node site/tools/render-cards.mjs      # screenshots them with any installed Chrome, Edge or Chromium (set CHROME=...)
python site/tools/images.py cards     # shrinks them to 256-color PNGs (Pillow)
node site/build.mjs                   # copies them into site/public/og/
```

The build warns about any card that hasn't been rendered yet. `python site/tools/images.py icons` redraws the PNG
favicons from the same geometry as `favicon.svg`.

## Share links

Topic pages and resident pages end with plain links to share on X (`x.com/intent/post`) and Farcaster
(`warpcast.com/~/compose`), with the page's text and URL prefilled. They're ordinary links: no scripts, no widgets,
and nothing is requested from either service until someone clicks.

## Planned: poll share pages (not built)

Polls need live data, so their pages will come later. The plan:

- **Route:** `/p/?id=<pollId>`, one static page, `p/index.html`. Its script reads `id`, validates it as a decimal
  poll id, and fills in the question, options and tallies. It shows a neutral "Loading…" state without the script.
- **Data:** read-only from a same-origin JSON endpoint (for example `/api/polls/<id>.json`, served by the courier or a
  Pages Function that reads `ZipPolls` events and caches them). That keeps `connect-src 'self'` in the CSP; no RPC
  calls from the browser.
- **Cards:** a static fallback card for all polls, since `og:image` can't be per-id on a static page. Per-poll cards
  would need a Pages Function that renders `/p/<id>/` with its own `<meta>` tags and a generated image.
- **Privacy:** tallies and the question only. Never who answered, never addresses, and results appear as delayed and
  coarse as the rest of Veridia's story.
- **Share:** the same plain X and Farcaster links, with the poll's question as the text.
