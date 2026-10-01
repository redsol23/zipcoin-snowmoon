"""Image steps that need Pillow. Run from the repository root.

    python site/tools/images.py cards   # shrink the rendered preview cards in site/src/static/og/ (256-color PNG)
    python site/tools/images.py poster  # the living Veridia poster (rendered by tools/render-poster.mjs) as avif/webp
    python site/tools/images.py icons   # copy the logo's favicon set from site/brand/favicon/

The cards are rendered first by tools/render-cards.mjs.
"""
import glob
import os
import sys

from PIL import Image


def cards():
    for path in sorted(glob.glob('site/src/static/og/*.png')):
        im = Image.open(path)
        if im.mode == 'P':
            continue  # already shrunk
        im = im.convert('RGB')
        assert im.size == (1200, 630), (path, im.size)
        im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(path, optimize=True)
        print(f'{path} {os.path.getsize(path) // 1024} KB')


def poster():
    im = Image.open('.local/site/poster/veridia-scene.png').convert('RGB')
    assert im.size == (1600, 820), im.size
    for w in (800, 1600):
        out = im if w == 1600 else im.resize((w, w * 820 // 1600), Image.LANCZOS)
        base = f'site/src/static/img/veridia-scene-{w}'
        out.save(base + '.avif', quality=60, speed=4)
        out.save(base + '.webp', quality=78, method=6)
        print(base, os.path.getsize(base + '.avif') // 1024, 'KB avif,', os.path.getsize(base + '.webp') // 1024, 'KB webp')


def icons():
    """Copy the favicon set of the logo (site/brand/favicon/, concept D) into the site's static files."""
    import shutil
    for name in ('favicon.svg', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'):
        shutil.copyfile(f'site/brand/favicon/{name}', f'site/src/static/{name}')
        print(f'site/src/static/{name}')


if __name__ == '__main__':
    {'cards': cards, 'icons': icons, 'poster': poster}[sys.argv[1] if len(sys.argv) > 1 else 'cards']()
