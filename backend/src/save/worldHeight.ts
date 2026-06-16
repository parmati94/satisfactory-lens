import { readFileSync } from 'fs';
import { join } from 'path';

// Static world terrain heightmap (baked from the game's HeightData_Test by
// generate_heightmap.py). Used to suggest a safe ground Z for teleporting —
// independent of any save. groundZ(cm) = a * (sampled value) + b.
interface HeightMeta {
  width: number; height: number;
  west: number; east: number; north: number; south: number;
  a: number; b: number;
}

let _meta: HeightMeta | null = null;
let _grid: Uint16Array | null = null;
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    _meta = JSON.parse(readFileSync(join(__dirname, '../../data/heightmap-meta.json'), 'utf-8'));
    const buf = readFileSync(join(__dirname, '../../data/heightmap.bin'));
    _grid = new Uint16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  } catch {
    _meta = null;
    _grid = null;
  }
}

/** Terrain surface height (game Z, cm) at world (x, y), or null if outside the world. */
export function groundZ(x: number, y: number): number | null {
  load();
  if (!_grid || !_meta) return null;
  const { width: W, height: H, west, east, north, south, a, b } = _meta;

  const fx = (x - west) / (east - west) * (W - 1);
  const fy = (y - north) / (south - north) * (H - 1);
  if (fx < 0 || fx > W - 1 || fy < 0 || fy > H - 1) return null;

  const x0 = Math.min(W - 2, Math.floor(fx));
  const y0 = Math.min(H - 2, Math.floor(fy));
  const dx = fx - x0, dy = fy - y0;
  const g = (c: number, r: number) => _grid![r * W + c] / 65535;
  const v =
    g(x0, y0) * (1 - dx) * (1 - dy) + g(x0 + 1, y0) * dx * (1 - dy) +
    g(x0, y0 + 1) * (1 - dx) * dy + g(x0 + 1, y0 + 1) * dx * dy;
  return a * v + b;
}
