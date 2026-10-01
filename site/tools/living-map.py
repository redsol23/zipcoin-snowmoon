"""Crops and encodes the living-map screenshot for the Veridia section.

    python site/tools/living-map.py <screenshot.png>

The source is a 1440 x 1000 screenshot of the Veridia page (dusk, light snow). Only the map panel is kept, so the
page chrome around it and the app's status chips at the top are dropped. Writes AVIF, WebP and PNG at two widths into site/src/static/img/.
"""
import os
import sys

from PIL import Image

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'static', 'img')
os.makedirs(out, exist_ok=True)

im = Image.open(src).convert('RGB')
assert im.size == (1440, 1000), im.size
# inside the panel's 1px border, and below the app's status chips (the build runs on a development chain)
panel = im.crop((170, 424, 1257, 933))

for w in (1087, 720):
    h = round(panel.height * w / panel.width)
    img = panel if w == panel.width else panel.resize((w, h), Image.LANCZOS)
    base = os.path.join(out, f'veridia-living-map-{w}')
    img.save(base + '.avif', quality=62, speed=4)
    img.save(base + '.webp', quality=80, method=6)
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(base + '.png', optimize=True)
    for ext in ('avif', 'webp', 'png'):
        print(f'{base}.{ext}', os.path.getsize(f'{base}.{ext}') // 1024, 'KB', img.size)
