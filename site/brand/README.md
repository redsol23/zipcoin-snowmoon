# zipcoin logo

The official zipcoin logo is **concept D, "Zipper Z"**: a Z whose diagonal is a closed zipper, on a night coin with a
green rim. The drawing is original, hand-built geometry with no fonts or stock art.

| File | Use |
|---|---|
| `zipcoin.svg` | Master mark, rim `#34bd7a`, for dark backgrounds (512 viewBox, transparent) |
| `zipcoin-light.svg` | Master mark, rim `#22a866`, for light backgrounds |
| `zipcoin-small.svg`, `zipcoin-small-light.svg` | The small drawing for 48 px and below: heavier Z and rim, a simpler zipper |
| `zipcoin-icon-dark.svg`, `zipcoin-icon-light.svg` | Square icons (night or snow background, mark at 84% so a circle crop keeps it whole) |
| `zipcoin-lockup-light.svg`, `zipcoin-lockup-dark.svg` | Mark plus the "zipcoin" wordmark (outlined), at 1x header size |
| `favicon/` | favicon.svg, favicon.ico (16/32/48), PNGs at 16/32/48, apple-touch-icon (180), icon-192/512, icon-maskable-512, avatar-512 |

Colours: night `#101b1a`, cream `#f4f0e1`, green `#22a866` (light) or `#34bd7a` (dark).

Where it is wired:
- zipcoin.org: the header and footer mark is `MARK` in `site/src/art.mjs` (the small drawing, rim in the page's green);
  the favicons and `site.webmanifest` icons are copied into `site/src/static/` by `python site/tools/images.py icons`.
- The web app: `apps/web/src/app/icon.svg` and `favicon.ico` (copies of `favicon/`), `apple-icon.png` (rendered by `python site/brand/render.py`), and the mark
  component `apps/web/src/components/Mark.tsx`.
