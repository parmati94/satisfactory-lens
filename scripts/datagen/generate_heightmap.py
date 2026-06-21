#!/usr/bin/env python3
"""
Bake the Satisfactory world heightmap into a runtime artifact for save editing
(safe teleport "snap to ground").

Source: the in-game map's height texture `HeightData_Test` (2048x2048, PF_R16F,
normalized 0..1). We downsample to 1024x1024, self-calibrate value -> game-Z (cm)
against resource-node positions (which sit on the terrain surface), and emit:
  backend/data/heightmap.bin       uint16 LE grid (value*65535), row-major (y, x)
  backend/data/heightmap-meta.json { width, height, west, east, north, south, a, b }
where  groundZ(cm) = a * (sample/65535) + b.
"""

import json
import numpy as np
from pathlib import Path

from _paths import CONTENT, BACKEND_DATA  # noqa: E402

UBULK = CONTENT / 'FactoryGame/Interface/UI/Assets/MapTest/HeightData_Test.ubulk'
NODES = BACKEND_DATA / 'resource-nodes.json'
OUT_BIN = BACKEND_DATA / 'heightmap.bin'
OUT_META = BACKEND_DATA / 'heightmap-meta.json'

# World bounds (cm) — must match the frontend map constants.
WEST, EAST, NORTH, SOUTH = -324698.832031, 425301.832031, -375000.0, 375000.0
SRC = 2048
DST = 1024


def main():
    raw = UBULK.read_bytes()[:SRC * SRC * 2]
    hm = np.frombuffer(raw, dtype=np.float16).astype(np.float32).reshape(SRC, SRC)
    # Downsample 2048 -> 1024 by averaging 2x2 blocks.
    grid = hm.reshape(DST, 2, DST, 2).mean(axis=(1, 3))  # [row=y, col=x], 0..1

    # Self-calibrate value -> Z (cm) against resource nodes (on the surface).
    nodes = json.loads(NODES.read_text())
    pts = np.array([[e['position']['x'], e['position']['y'], e['position']['z']]
                    for e in nodes.values() if e.get('position')])
    xs, ys, zs = pts[:, 0], pts[:, 1], pts[:, 2]

    def bilinear(x, y):
        fx = (x - WEST) / (EAST - WEST) * (DST - 1)
        fy = (y - NORTH) / (SOUTH - NORTH) * (DST - 1)
        x0 = np.clip(np.floor(fx).astype(int), 0, DST - 2)
        y0 = np.clip(np.floor(fy).astype(int), 0, DST - 2)
        dx, dy = fx - x0, fy - y0
        return (grid[y0, x0] * (1 - dx) * (1 - dy) + grid[y0, x0 + 1] * dx * (1 - dy)
                + grid[y0 + 1, x0] * (1 - dx) * dy + grid[y0 + 1, x0 + 1] * dx * dy)

    v = bilinear(xs, ys)
    mask = np.ones(len(v), bool)
    a = b = 0.0
    for _ in range(3):
        a, b = np.polyfit(v[mask], zs[mask], 1)
        res = zs - (a * v + b)
        mask = np.abs(res) < 2.5 * res[mask].std()
    err = np.abs(zs - (a * v + b))[mask] / 100
    print(f'calibrated Z = {a:.1f}*v + {b:.1f}  | kept {mask.sum()}/{len(v)}  '
          f'| err(m) median {np.median(err):.1f} p90 {np.percentile(err,90):.1f}')

    OUT_BIN.write_bytes((np.clip(grid, 0, 1) * 65535).round().astype('<u2').tobytes())
    OUT_META.write_text(json.dumps({
        'width': DST, 'height': DST,
        'west': WEST, 'east': EAST, 'north': NORTH, 'south': SOUTH,
        'a': float(a), 'b': float(b),
    }, indent=2))
    print(f'Wrote {OUT_BIN} ({OUT_BIN.stat().st_size} bytes) + {OUT_META.name}')


if __name__ == '__main__':
    main()
