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

The crop+save loop is the bulk of the work, so it is parallelised across
CPU cores by column. Workers inherit the scaled image via fork copy-on-write
(no pickling), and each worker owns whole columns, so no two processes ever
write the same tile. Resize and PNG settings are unchanged, so output tiles
are byte-identical to the single-threaded version.

Usage:
  python3 scripts/slice_map.py
"""

import os
from multiprocessing import get_context
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SCRIPTS_DIR  = Path(__file__).parent
PROJECT_ROOT = SCRIPTS_DIR.parent
SOURCE       = PROJECT_ROOT / 'frontend' / 'public' / 'img' / 'map_16k.jpg'
TILES_OUT    = PROJECT_ROOT / 'frontend' / 'public' / 'tiles'
TILE_PX      = 256
OUTPUT_ZOOMS = range(3, 7)   # z3, z4, z5, z6

# Set per-zoom in the parent before each pool is created; forked workers
# inherit it copy-on-write and only ever read from it.
_SCALED = None


def _write_column(args):
    """Crop and save every tile in one column (tx) of one zoom level."""
    zoom, tx, n = args
    col = TILES_OUT / str(zoom) / str(tx)
    col.mkdir(parents=True, exist_ok=True)
    for ty in range(n):
        tile = _SCALED.crop((tx * TILE_PX, ty * TILE_PX, (tx + 1) * TILE_PX, (ty + 1) * TILE_PX))
        tile.save(str(col / f'{ty}.png'), 'PNG', compress_level=6)
    return n


def main():
    global _SCALED

    print(f'Loading {SOURCE.name} ({SOURCE.stat().st_size/1024/1024:.1f} MB)…')
    src = Image.open(str(SOURCE)).convert('RGB')
    print(f'Source size: {src.size[0]}×{src.size[1]}')

    ctx    = get_context('fork')
    nproc  = os.cpu_count() or 4
    print(f'Using {nproc} worker processes.')

    for zoom in OUTPUT_ZOOMS:
        n      = 2 ** zoom
        canvas = n * TILE_PX

        print(f'\nz={zoom}: {n}×{n} tiles → scaling to {canvas}×{canvas}…')
        _SCALED = src.resize((canvas, canvas), Image.LANCZOS)

        # Pool is created after _SCALED is assigned, so each forked worker
        # inherits this zoom's scaled image.
        with ctx.Pool(nproc) as pool:
            counts = pool.map(_write_column, [(zoom, tx, n) for tx in range(n)])
        print(f'  {sum(counts)} tiles written.')

    _SCALED = None

    total_files = sum(1 for _ in TILES_OUT.rglob('*.png'))
    total_mb    = sum(f.stat().st_size for f in TILES_OUT.rglob('*.png')) / 1024 / 1024
    print(f'\nDone. {total_files} tiles, {total_mb:.0f} MB → {TILES_OUT}')


if __name__ == '__main__':
    main()
