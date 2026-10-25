"""Generate the extension's icons from Diffinery's mark.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools picosvg brotli pillow
    /tmp/v/bin/python apps/vscode/scripts/make-icons.py

Writes apps/vscode/media/icon.png (the extension's 128 px icon, the site's app icon scaled
down) and apps/vscode/media/diffinery-icons.woff (a one-glyph icon font, so the clone picker
can show the mark as `$(diffinery-logo)` next to "Clone from Diffinery", the way GitHub's shows its
logo). The output is committed, so builds need none of these tools.
"""
import base64
import io
import os
import re

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import SVGPath
from PIL import Image
from picosvg.svg import SVG

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "..", "media")
SITE_ICONS = os.path.join(HERE, "..", "..", "diffinery", "src", "web", "icons.generated.ts")
# The mark, as in apps/diffinery/src/web/assets.ts (ICONS.logo), on a 24-unit grid.
MARK = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.3 7.2c4 1 7.4 2.2 7.6 3.3M8.3 16.8c4-1 7.4-2.2 7.6-3.3"/></svg>"""
CODEPOINT = 0xE001
UPM = 1000


def extension_icon():
    src = open(SITE_ICONS).read()
    m = re.search(r'"icon-512\.png":\s*"([A-Za-z0-9+/=]+)"', src)
    if not m:
        raise SystemExit("icon-512.png not found in icons.generated.ts")
    img = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGBA")
    img.resize((128, 128), Image.LANCZOS).save(os.path.join(MEDIA, "icon.png"), optimize=True)


def icon_font():
    # Strokes become filled outlines, as a font needs.
    flat = SVG.fromstring(MARK).topicosvg()
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder([".notdef", "diffinery"])
    fb.setupCharacterMap({CODEPOINT: "diffinery"})
    pen = TTGlyphPen(None)
    # 24 units -> 1000, y up, baseline at the bottom of the grid.
    scale = UPM / 24
    for el in flat.shapes():
        SVGPath.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg"><path d="{el.d}"/></svg>').draw(
            TransformPen(Cu2QuPen(pen, 1.0, reverse_direction=True), (scale, 0, 0, -scale, 0, UPM))
        )
    glyphs = {".notdef": TTGlyphPen(None).glyph(), "diffinery": pen.glyph()}
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({".notdef": (UPM, 0), "diffinery": (UPM, 0)})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({"familyName": "diffinery-icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    fb.font.flavor = "woff"
    fb.save(os.path.join(MEDIA, "diffinery-icons.woff"))


if __name__ == "__main__":
    os.makedirs(MEDIA, exist_ok=True)
    extension_icon()
    icon_font()
    print("wrote media/icon.png and media/diffinery-icons.woff")
