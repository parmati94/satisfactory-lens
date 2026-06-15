#!/usr/bin/env python3
"""
Slice the committed source map image into XYZ tiles for Leaflet.

Source : frontend/public/img/map_16k.jpg  (16384×16384, committed to git)
Output : frontend/public/tiles/{z}/{x}/{y}.png  (gitignored)

Zoom levels z3–z6:
  z3:  8×8   =    64 tiles  (overview)
  z4: 16×16  =   256 tiles
  z5: 32×32  =  1024 tiles
  z6: 64×64  =  4096 tiles  (native — 64×256 = 16384px)

Usage:
  python3 scripts/slice_map.py
"""

from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SCRIPTS_DIR  = Path(__file__).parent
PROJECT_ROOT = SCRIPTS_DIR.parent
SOURCE       = PROJECT_ROOT / 'frontend' / 'public' / 'img' / 'map_16k.jpg'
TILES_OUT    = PROJECT_ROOT / 'frontend' / 'public' / 'tiles'
TILE_PX      = 256
OUTPUT_ZOOMS = range(3, 7)   # z3, z4, z5, z6

print(f'Loading {SOURCE.name} ({SOURCE.stat().st_size/1024/1024:.1f} MB)…')
src = Image.open(str(SOURCE)).convert('RGB')
print(f'Source size: {src.size[0]}×{src.size[1]}')

for zoom in OUTPUT_ZOOMS:
    n      = 2 ** zoom
    canvas = n * TILE_PX

    print(f'\nz={zoom}: {n}×{n} tiles → scaling to {canvas}×{canvas}…')
    scaled = src.resize((canvas, canvas), Image.LANCZOS)

    written = 0
    for tx in range(n):
        col = TILES_OUT / str(zoom) / str(tx)
        col.mkdir(parents=True, exist_ok=True)
        for ty in range(n):
            tile = scaled.crop((tx*TILE_PX, ty*TILE_PX, (tx+1)*TILE_PX, (ty+1)*TILE_PX))
            tile.save(str(col / f'{ty}.png'), 'PNG', compress_level=6)
            written += 1
    print(f'  {written} tiles written.')

total_files = sum(1 for _ in TILES_OUT.rglob('*.png'))
total_mb    = sum(f.stat().st_size for f in TILES_OUT.rglob('*.png')) / 1024 / 1024
print(f'\nDone. {total_files} tiles, {total_mb:.0f} MB → {TILES_OUT}')
