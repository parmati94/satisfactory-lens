#!/usr/bin/env python3
"""
Generate Leaflet map marker PNGs from Satisfactory pak textures.

Decodes raw game UI textures (DXT5) and composites them into ready-to-use
marker icons for the satisfactory-lens frontend.

Usage:
    python3 generate_markers.py [--out <dir>]

Output dir defaults to: ../../satisfactory-lens/frontend/public/assets/players/
"""

import argparse
import sys
from pathlib import Path

try:
    import texture2ddecoder
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Missing deps — run: pip install texture2ddecoder Pillow")

from _paths import CONTENT, FRONTEND_ASSETS  # noqa: E402

ASSETS_UI   = CONTENT / 'FactoryGame/Interface/UI/Assets'
DEFAULT_OUT = FRONTEND_ASSETS / 'players'

# Texture sources
PIONEER_UBULK  = ASSETS_UI / 'MonochromeIcons/TXUI_MIcon_Pioneer.ubulk'
PIONEER_SIZE   = (128, 128)
HUB_UASSET     = ASSETS_UI / 'Map/MapCompass_Icon_hub.uasset'
HUB_MIP0_OFF   = 0x110       # ForceInlinePayload offset from JSON
HUB_SIZE       = (64, 64)

# Shared composite params
CANVAS       = 128
RING_MARGIN  = 4
RING_THICK   = 6
FINAL_SIZE   = 28   # match resource node icon size
SF_ORANGE    = (232, 133, 42, 255)
SF_BLUE      = ( 65, 145, 230, 255)
WHITE        = (255, 255, 255, 255)


def decode_dxt5_ubulk(ubulk_path: Path, width: int, height: int) -> Image.Image:
    raw = ubulk_path.read_bytes()
    expected = (width // 4) * (height // 4) * 16
    raw = raw[:expected]
    rgba = texture2ddecoder.decode_bc3(raw, width, height)
    return Image.frombytes('RGBA', (width, height), rgba, 'raw', 'BGRA')


def decode_dxt5_inline(uasset_path: Path, offset: int, width: int, height: int) -> Image.Image:
    """Extract DXT5 texture from an inline (ForceInlinePayload) uasset."""
    data = uasset_path.read_bytes()
    expected = (width // 4) * (height // 4) * 16
    raw = data[offset:offset + expected]
    rgba = texture2ddecoder.decode_bc3(raw, width, height)
    img = Image.frombytes('RGBA', (width, height), rgba, 'raw', 'BGRA')
    # Zero out garbage rows (non-white opaque pixels from package header bleed)
    for y in range(height):
        row = [img.getpixel((x, y)) for x in range(width)]
        opaque = [p for p in row if p[3] > 50]
        white  = [p for p in opaque if p[0] > 180 and p[1] > 180 and p[2] > 180]
        if opaque and len(white) < len(opaque) * 0.5:
            for x in range(width):
                img.putpixel((x, y), (0, 0, 0, 0))
    return img


def make_marker(icon: Image.Image, fill_color: tuple, stroke_color: tuple = WHITE) -> Image.Image:
    canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse(
        [RING_MARGIN, RING_MARGIN, CANVAS - RING_MARGIN - 1, CANVAS - RING_MARGIN - 1],
        fill=stroke_color,
    )
    fi = RING_MARGIN + RING_THICK
    draw.ellipse([fi, fi, CANVAS - fi - 1, CANVAS - fi - 1], fill=fill_color)

    bbox = icon.getbbox()
    icon_crop = icon.crop(bbox) if bbox else icon
    icon_size = int(CANVAS * 0.55)
    icon_scaled = icon_crop.resize((icon_size, icon_size), Image.LANCZOS)
    offset = (CANVAS - icon_size) // 2
    canvas.paste(icon_scaled, (offset, offset), icon_scaled)

    return canvas.resize((FINAL_SIZE, FINAL_SIZE), Image.LANCZOS)


def make_pin_icon() -> Image.Image:
    """Programmatic map-pin silhouette (white on transparent) for stamp markers."""
    pin = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(pin)
    draw.ellipse([10, 4, 54, 48], fill=(255, 255, 255, 255))
    draw.ellipse([22, 16, 42, 36], fill=(0, 0, 0, 0))
    draw.polygon([(10, 30), (54, 30), (32, 62)], fill=(255, 255, 255, 255))
    return pin


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print('Decoding TXUI_MIcon_Pioneer…')
    pioneer = decode_dxt5_ubulk(PIONEER_UBULK, *PIONEER_SIZE)

    print('Decoding MapCompass_Icon_hub (inline)…')
    hub_icon = decode_dxt5_inline(HUB_UASSET, HUB_MIP0_OFF, *HUB_SIZE)

    print('Building pin icon (programmatic)…')
    pin_icon = make_pin_icon()

    outputs = [
        ('player_marker.png',      pioneer,  SF_ORANGE, 'player — SF orange'),
        ('player_marker_self.png', pioneer,  SF_BLUE,   'local player — blue'),
        ('hub_marker.png',         hub_icon, SF_ORANGE, 'HUB terminal — SF orange'),
        ('stamp_marker.png',       pin_icon, SF_BLUE,   'map stamp base (color overridden in frontend)'),
    ]

    for filename, icon, fill, label in outputs:
        img = make_marker(icon, fill_color=fill)
        path = out / filename
        img.save(path)
        print(f'  → {filename}  ({label})')

    print(f'\nDone. {len(outputs)} markers → {out}')


if __name__ == '__main__':
    main()
