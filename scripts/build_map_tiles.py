#!/usr/bin/env python3
"""
Build local map tiles for satisfactory-lens.

Steps:
  1. Download SCIM z=8 tiles (skips cached, skips 404s)
  2. Stitch into full 40960×40960 canvas, crop 4096px gray border → 32768×32768
  3. Downsample to 8192×8192, save as map_8k.webp (commit this to git)
  4. Slice into XYZ tiles at z3–z5 → frontend/public/tiles/{z}/{x}/{y}.png

Usage:
  python3 scripts/build_map_tiles.py               # full run
  python3 scripts/build_map_tiles.py --skip-download   # skip step 1 (use cache)
  python3 scripts/build_map_tiles.py --slice-only      # skip to step 4 (needs map_8k.webp)
"""

import sys
import time
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from PIL import Image

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPTS_DIR  = Path(__file__).parent
PROJECT_ROOT = SCRIPTS_DIR.parent
CACHE_DIR    = SCRIPTS_DIR / '_scim_tile_cache'
SOURCE_WEBP  = SCRIPTS_DIR / 'map_8k.webp'          # committed to git
TILES_OUT    = PROJECT_ROOT / 'frontend' / 'public' / 'tiles'

# ── Config ────────────────────────────────────────────────────────────────────

SCIM_BASE   = 'https://static.satisfactory-calculator.com/imgMap/gameLayer/Stable'
SCIM_ZOOM   = 8
GRID        = 160        # 160×160 tiles at z=8 → 40960px canvas
TILE_PX     = 256
BORDER_PX   = 4096       # SCIM gray border each side
GAME_PX     = 32768      # clean game world (no border)
OUTPUT_SIZE = 8192        # downsample target for committed source image
OUTPUT_ZOOMS = range(3, 6)  # z3, z4, z5 — native zoom = 5 (log2(8192/256))

WORKERS     = 16
DELAY       = 0.04       # seconds between requests per thread

HEADERS = {
    'Referer':    'https://satisfactory-calculator.com/',
    'User-Agent': 'Mozilla/5.0 (compatible; satisfactory-lens/1.0)',
}

# ── Step 1: Download ──────────────────────────────────────────────────────────

def fetch_tile(z, x, y, session):
    path = CACHE_DIR / str(z) / str(x) / f'{y}.png'
    if path.exists():
        return x, y, True

    url = f'{SCIM_BASE}/{z}/{x}/{y}.png'
    try:
        r = session.get(url, headers=HEADERS, timeout=15)
        if r.status_code == 200:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            time.sleep(DELAY)
            return x, y, True
        return x, y, False
    except Exception as e:
        print(f'  WARN {z}/{x}/{y}: {e}')
        return x, y, False


def download_tiles():
    print(f'Step 1: Downloading SCIM z={SCIM_ZOOM} tiles ({GRID}×{GRID} grid = {GRID*GRID:,} total)…')
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    coords = [(x, y) for x in range(GRID) for y in range(GRID)]
    done = hits = 0
    lock = threading.Lock()
    session = requests.Session()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_tile, SCIM_ZOOM, x, y, session): (x, y)
                   for x, y in coords}
        for fut in as_completed(futures):
            _, _, ok = fut.result()
            with lock:
                done += 1
                if ok: hits += 1
                if done % 1000 == 0 or done == len(coords):
                    print(f'  {done:,}/{len(coords):,}  content tiles: {hits:,}')

    print(f'Download complete — {hits:,} tiles with content.')


# ── Step 2 & 3: Stitch → crop → downsample ───────────────────────────────────

def build_source_image():
    """
    Stitch tiles in horizontal strips to keep peak RAM under ~1.5GB.
    Each strip is STRIP_COLS columns wide × full height, downsampled immediately.
    """
    canvas_px  = GRID * TILE_PX   # 40960
    STRIP_COLS = 16               # process 16 columns (~640MB per strip)

    # Tile coordinates of the cropped game area
    border_tiles = BORDER_PX // TILE_PX      # 16 tiles
    game_tiles   = GAME_PX // TILE_PX        # 128 tiles

    print(f'\nStep 2: Stitching into {OUTPUT_SIZE}×{OUTPUT_SIZE} via {GRID//STRIP_COLS} strips…')

    # Scale factor: game_tiles → OUTPUT_SIZE
    scale = OUTPUT_SIZE / GAME_PX            # 8192/32768 = 0.25

    out_col_px = round(game_tiles * TILE_PX * scale)  # output width = OUTPUT_SIZE
    out_row_px = OUTPUT_SIZE

    result = Image.new('RGB', (OUTPUT_SIZE, OUTPUT_SIZE), (0, 0, 0))

    for strip_start in range(0, GRID, STRIP_COLS):
        strip_end = min(strip_start + STRIP_COLS, GRID)
        strip_w   = (strip_end - strip_start) * TILE_PX

        # Build full-height strip
        strip = Image.new('RGB', (strip_w, canvas_px), (0, 0, 0))
        for xi, x in enumerate(range(strip_start, strip_end)):
            for y in range(GRID):
                path = CACHE_DIR / str(SCIM_ZOOM) / str(x) / f'{y}.png'
                if path.exists():
                    try:
                        strip.paste(Image.open(path).convert('RGB'),
                                    (xi * TILE_PX, y * TILE_PX))
                    except Exception:
                        pass

        # Crop to game area (remove top/bottom border)
        crop_top  = BORDER_PX
        crop_bot  = canvas_px - BORDER_PX
        # Crop left border only for the first strip column (16 tiles in)
        crop_left  = max(0, BORDER_PX - strip_start * TILE_PX)
        crop_right = min(strip_w, (BORDER_PX + GAME_PX) - strip_start * TILE_PX)

        if crop_right <= crop_left:
            del strip
            continue

        cropped = strip.crop((crop_left, crop_top, crop_right, crop_bot))
        del strip

        # Downsample cropped portion to output size
        out_w = round(cropped.width  * scale)
        out_h = round(cropped.height * scale)
        small = cropped.resize((out_w, out_h), Image.LANCZOS)
        del cropped

        # Paste into correct x position in result
        out_x = round(max(0, (strip_start - border_tiles) * TILE_PX * scale))
        result.paste(small, (out_x, 0))
        del small

        print(f'  strip x={strip_start}–{strip_end-1} done  (out_x={out_x})')

    print(f'\nStep 3: Saving {OUTPUT_SIZE}×{OUTPUT_SIZE} webp → {SOURCE_WEBP.name}…')
    result.save(str(SOURCE_WEBP), 'WEBP', quality=90, method=6)
    mb = SOURCE_WEBP.stat().st_size / 1024 / 1024
    print(f'  Saved {SOURCE_WEBP} ({mb:.1f} MB)')
    return result


# ── Step 4: Slice into XYZ tiles ─────────────────────────────────────────────

def slice_tiles(src):
    print(f'\nStep 4: Slicing into XYZ tiles at zooms {list(OUTPUT_ZOOMS)}…')

    for zoom in OUTPUT_ZOOMS:
        n = 2 ** zoom          # tiles per side
        px = n * TILE_PX       # canvas size for this zoom

        print(f'  z={zoom}: {n}×{n} tiles, scaling source to {px}×{px}…')
        scaled = src.resize((px, px), Image.LANCZOS)

        written = 0
        for tx in range(n):
            col = TILES_OUT / str(zoom) / str(tx)
            col.mkdir(parents=True, exist_ok=True)
            for ty in range(n):
                tile = scaled.crop((tx*TILE_PX, ty*TILE_PX, (tx+1)*TILE_PX, (ty+1)*TILE_PX))
                tile.save(str(col / f'{ty}.png'), 'PNG', compress_level=6)
                written += 1
        print(f'    {written} tiles written.')

    total_files = sum(1 for _ in TILES_OUT.rglob('*.png'))
    total_mb    = sum(f.stat().st_size for f in TILES_OUT.rglob('*.png')) / 1024 / 1024
    print(f'\nDone. {total_files} tiles, {total_mb:.0f} MB → {TILES_OUT}')


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    skip_download = '--skip-download' in sys.argv
    slice_only    = '--slice-only'    in sys.argv

    if slice_only:
        if not SOURCE_WEBP.exists():
            print(f'ERROR: {SOURCE_WEBP} not found. Run without --slice-only first.')
            sys.exit(1)
        print(f'Loading {SOURCE_WEBP}…')
        src = Image.open(str(SOURCE_WEBP))
        slice_tiles(src)
    else:
        if not skip_download:
            download_tiles()
        src = build_source_image()
        slice_tiles(src)
