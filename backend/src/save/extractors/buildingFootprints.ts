import { Parser } from '@etothepii/satisfactory-file-parser';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  forEachBuildingInstance,
  buildClassFromTypePath,
  buildingLabel,
  categoryFromTypePath,
  type BuildingInstance,
} from './buildings';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

interface Footprint {
  width: number;
  depth: number;
  height: number;
  offsetX: number;
  offsetY: number;
  // Optional top-down silhouette polygon (building-local game-cm, [[x,y],...])
  // derived from the mesh collision hull — see generate_building_footprints.py.
  // Present only for buildings with a non-rectangular shape; the frontend draws
  // it instead of the box, falling back to the box when absent. When `relief` is
  // present this is the relief image's outer contour (used for hover/hit-test).
  outline?: number[][];
  // Optional top-down height-relief image (frontend/public/assets/building-relief
  // /<buildClass>.png). When present, the map draws that PNG tinted by category
  // colour instead of a flat fill. w/d = footprint bbox size (cm); cx/cy = bbox
  // centre offset in building-local cm; pw/ph = PNG pixel dimensions.
  relief?: { w: number; d: number; cx: number; cy: number; pw: number; ph: number };
}

const DEFAULT_FOOTPRINT: Footprint = { width: 100, depth: 100, height: 100, offsetX: 0, offsetY: 0 };

// Loaded once at module init — maps Build_ClassName → footprint box (see
// generate_building_footprints.py for how this is derived from pak data).
let _footprintMap: Record<string, Footprint> | null = null;
function getFootprintMap(): Record<string, Footprint> {
  if (!_footprintMap) {
    try {
      const p = join(__dirname, '../../../data/buildable-footprints.json');
      _footprintMap = JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      _footprintMap = {};
    }
  }
  return _footprintMap!;
}

// Muted "cartographic" palette: harmonized saturation/lightness so colours read
// as a designed set rather than clashing primaries on the dark map. Active
// categories keep moderate saturation to stay legible; structural/passive ones
// (foundations, walls, roofs — the "factory floor") recede into dark slate so the
// machines on top of them are what the eye lands on.
const CATEGORY_COLOR: Record<string, string> = {
  'Production':             '#cf7a4d', // terracotta
  'Miners & Extractors':    '#a8795a', // clay brown
  'Power':                  '#d9b24a', // muted gold
  'Power Infrastructure':   '#bd9a3f', // dim gold
  'Conveyors & Belts':      '#8a98a8', // slate
  'Pipes & Fluids':         '#5d86b0', // dusty blue
  'Hypertubes':             '#5aa6ad', // muted teal
  'Trains & Rails':         '#9a83c0', // dusty purple
  'Logistics':              '#c47fa3', // dusty rose
  'Storage':                '#6fae84', // sage green
  'Foundations':            '#3a3f4b', // dark slate (recede)
  'Walls':                  '#474d5a', // slate (recede)
  'Ramps':                  '#474d5a',
  'Stairs & Walkways':      '#474d5a',
  'Roofs & Pillars':        '#474d5a',
  'Lights':                 '#ddca8e', // warm sand
  'Signs & Displays':       '#c66b5e', // muted red
  'Workbenches & Research': '#4fa593', // teal
  'HUB & Milestones':       '#d98a4a', // amber landmark
  'Decor':                  '#92bd96', // pale sage
  'Miscellaneous':          '#828b99', // gray
};
const DEFAULT_COLOR = '#828b99';

function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? DEFAULT_COLOR;
}

// Yaw (radians) around the world Z axis. Buildings overwhelmingly only rotate
// around Z for placement — this simplified form is exact for a pure-Z
// rotation (x=y=0) and a reasonable approximation otherwise (rare uneven-
// terrain tilt), which is all that matters for a 2D footprint heading.
function yawFromQuat(rot: BuildingInstance['rot']): number {
  return 2 * Math.atan2(rot.z, rot.w);
}

// ── Spline buildables (belts, pipes, hypertubes, rails) ─────────────────────
// These carry an mSplineData property: spline points (local to the object's
// transform) with arrive/leave tangents. We reconstruct the world-space path so
// the map can draw them as lines instead of point footprints.

interface V3 { x: number; y: number; z: number; }
interface P2 { x: number; y: number; }

// Rotate a vector by a quaternion (standard q * v * q⁻¹, expanded).
function rotateByQuat(q: BuildingInstance['rot'], v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

// Cubic-Hermite tessellation of one segment, appending [x,y,...] (excluding the
// start point, which the caller already emitted). Straight segments collapse to
// a single point; curved ones subdivide in proportion to how much the tangents
// bend away from the chord, so straight runs stay cheap.
function tessellateSegment(p0: P2, m0: P2, p1: P2, m1: P2, out: number[]): void {
  const chordX = p1.x - p0.x, chordY = p1.y - p0.y;
  const chordLen = Math.hypot(chordX, chordY) || 1;
  const angleToChord = (mx: number, my: number) => {
    const ml = Math.hypot(mx, my) || 1;
    const dot = (mx * chordX + my * chordY) / (ml * chordLen);
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  };
  const maxAngle = Math.max(angleToChord(m0.x, m0.y), angleToChord(m1.x, m1.y));
  let steps = 1;
  if (maxAngle > 0.09) steps = Math.min(12, Math.max(2, Math.round(maxAngle / 0.1)));

  for (let s = 1; s <= steps; s++) {
    const t = s / steps, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push(
      Math.round(h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x),
      Math.round(h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y),
    );
  }
}

// Build a flat world-space polyline [x0,y0,x1,y1,...] from an object's
// mSplineData, or null if it has none. Spline points & tangents are local to the
// object transform, so each is rotated by the transform's quaternion and offset
// by its translation.
function worldPolylineFromSpline(obj: any): number[] | null {
  const values = obj?.properties?.mSplineData?.values;
  if (!Array.isArray(values) || values.length < 2) return null;
  const t = obj.transform ?? {};
  const tr = t.translation ?? { x: 0, y: 0, z: 0 };
  const q = t.rotation ?? { x: 0, y: 0, z: 0, w: 1 };

  const loc: P2[] = [], leave: P2[] = [], arrive: P2[] = [];
  for (const v of values) {
    const p = v?.properties;
    const l = p?.Location?.value ?? { x: 0, y: 0, z: 0 };
    const lv = p?.LeaveTangent?.value ?? { x: 0, y: 0, z: 0 };
    const av = p?.ArriveTangent?.value ?? { x: 0, y: 0, z: 0 };
    const wl = rotateByQuat(q, l);
    loc.push({ x: tr.x + wl.x, y: tr.y + wl.y });
    const rlv = rotateByQuat(q, lv), rav = rotateByQuat(q, av);
    leave.push({ x: rlv.x, y: rlv.y });
    arrive.push({ x: rav.x, y: rav.y });
  }

  const out: number[] = [Math.round(loc[0].x), Math.round(loc[0].y)];
  for (let i = 0; i < loc.length - 1; i++) {
    tessellateSegment(loc[i], leave[i], loc[i + 1], arrive[i + 1], out);
  }
  return out;
}

export interface BuildingFootprintType {
  buildClass: string;
  label: string;
  category: string;
  color: string;
  footprint: Footprint;
}

// One drawable group of spline paths of a single build class (so they share a
// colour, label and icon). Each entry of `lines` is a flat [x0,y0,x1,y1,...]
// world-space polyline (game cm) — one whole belt/pipe/rail object.
export interface BuildingSplineGroup {
  buildClass: string;
  label: string;
  category: string;
  color: string;
  lines: number[][];
}

export interface BuildingFootprints {
  types: BuildingFootprintType[];
  // Per-instance, parallel arrays — index into `types` rather than repeating
  // strings, to keep the payload small at tens of thousands of instances.
  typeIndex: number[];
  x: number[];
  y: number[];
  yaw: number[];
  // Belts/pipes/hypertubes/rails drawn as lines rather than point footprints.
  splines: BuildingSplineGroup[];
}

export function extractBuildingFootprints(save: SatisfactorySave): BuildingFootprints {
  const footprintMap = getFootprintMap();
  const typeIndexByClass = new Map<string, number>();
  const types: BuildingFootprintType[] = [];
  const typeIndex: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const yaw: number[] = [];
  const splineGroups = new Map<string, BuildingSplineGroup>();

  forEachBuildingInstance(save, (typePath, instance, obj) => {
    // Belts/pipes/hypertubes/rails: draw the actual spline path as a line and
    // skip the point-footprint rectangle entirely.
    const polyline = obj ? worldPolylineFromSpline(obj) : null;
    if (polyline) {
      const buildClass = buildClassFromTypePath(typePath);
      let group = splineGroups.get(buildClass);
      if (!group) {
        const category = categoryFromTypePath(typePath);
        group = { buildClass, label: buildingLabel(typePath), category, color: categoryColor(category), lines: [] };
        splineGroups.set(buildClass, group);
      }
      group.lines.push(polyline);
      return;
    }

    const buildClass = buildClassFromTypePath(typePath);

    let idx = typeIndexByClass.get(buildClass);
    if (idx === undefined) {
      idx = types.length;
      typeIndexByClass.set(buildClass, idx);
      const category = categoryFromTypePath(typePath);
      types.push({
        buildClass,
        label: buildingLabel(typePath),
        category,
        color: categoryColor(category),
        footprint: footprintMap[buildClass] ?? DEFAULT_FOOTPRINT,
      });
    }

    typeIndex.push(idx);
    x.push(Math.round(instance.pos.x));
    y.push(Math.round(instance.pos.y));
    yaw.push(yawFromQuat(instance.rot));
  });

  return { types, typeIndex, x, y, yaw, splines: Array.from(splineGroups.values()) };
}
