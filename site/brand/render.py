"""Renders the logo PNGs the apps use, from the master SVGs in this folder. Run from the repository root:

    python site/brand/render.py

Writes apps/web/src/app/apple-icon.png. Needs Pillow and an installed Chrome or Edge (set CHROME=/path/to/chrome if it
isn't found).
"""
import os
import pathlib
import subprocess
import tempfile

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
APP = ROOT / 'apps' / 'web' / 'src' / 'app'
NIGHT = (0x10, 0x1B, 0x1A)


def browser():
    for c in [os.environ.get('CHROME'), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
              'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']:
        if c and os.path.exists(c):
            return c
    raise SystemExit('no Chromium-family browser; set CHROME')


def svg_png(svg_file, size):
    """Render one SVG at size x size with a transparent background."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='brand-'))
    page = tmp / 'p.html'
    page.write_text(f'<!doctype html><style>html,body{{margin:0;background:transparent}}img{{display:block;width:{size}px;height:{size}px}}</style>'
                    f'<img src="{(HERE / svg_file).as_uri()}">', encoding='utf8')
    shot = tmp / 's.png'
    subprocess.run([browser(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
                    '--default-background-color=00000000', '--force-device-scale-factor=1', '--allow-file-access-from-files',
                    f'--user-data-dir={tmp / "profile"}', '--virtual-time-budget=2000',
                    f'--window-size={max(size, 800)},{max(size, 600) + 100}', f'--screenshot={shot}', page.as_uri()],
                   capture_output=True, timeout=90)
    return Image.open(shot).convert('RGBA').crop((0, 0, size, size))


def on(bg, mark, size, at):
    """The mark over an opaque background (no alpha channel in the result)."""
    im = Image.new('RGB', size, bg)
    im.paste(mark, at, mark)
    return im


def main():
    # the web app: Next's app/apple-icon.png (app/icon.svg and app/favicon.ico are copies of favicon/)
    on(NIGHT, svg_png('zipcoin.svg', 152), (180, 180), (14, 14)).save(APP / 'apple-icon.png', optimize=True)
    for p in [APP / 'apple-icon.png']:
        im = Image.open(p)
        print(p.relative_to(ROOT), im.size, im.mode, f'{p.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
