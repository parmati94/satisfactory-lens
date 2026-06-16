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

// Muted for structural/passive categories (foundations, walls, etc. — the
// "factory floor" rather than the machines on it), vivid for everything active.
const CATEGORY_COLOR: Record<string, string> = {
  'Production':             '#f97316', // orange
  'Miners & Extractors':    '#a16207', // brown
  'Power':                  '#facc15', // yellow
  'Power Infrastructure':   '#eab308', // dim yellow
  'Conveyors & Belts':      '#94a3b8', // slate
  'Pipes & Fluids':         '#3b82f6', // blue
  'Hypertubes':             '#06b6d4', // cyan
  'Trains & Rails':         '#a855f7', // purple
  'Logistics':              '#ec4899', // pink
  'Storage':                '#22c55e', // green
  'Foundations':            '#52525b', // muted gray
  'Walls':                  '#71717a', // muted gray
  'Ramps':                  '#71717a',
  'Stairs & Walkways':      '#71717a',
  'Roofs & Pillars':        '#71717a',
  'Lights':                 '#fde68a', // pale yellow
  'Signs & Displays':       '#ef4444', // red
  'Workbenches & Research': '#14b8a6', // teal
  'HUB & Milestones':       '#fb923c', // bright orange
  'Decor':                  '#86efac', // pale green
  'Miscellaneous':          '#9ca3af', // gray
};
const DEFAULT_COLOR = '#9ca3af';

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

export interface BuildingFootprintType {
  buildClass: string;
  label: string;
  category: string;
  color: string;
  footprint: Footprint;
}

export interface BuildingFootprints {
  types: BuildingFootprintType[];
  // Per-instance, parallel arrays — index into `types` rather than repeating
  // strings, to keep the payload small at tens of thousands of instances.
  typeIndex: number[];
  x: number[];
  y: number[];
  yaw: number[];
}

export function extractBuildingFootprints(save: SatisfactorySave): BuildingFootprints {
  const footprintMap = getFootprintMap();
  const typeIndexByClass = new Map<string, number>();
  const types: BuildingFootprintType[] = [];
  const typeIndex: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const yaw: number[] = [];

  forEachBuildingInstance(save, (typePath, instance) => {
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

  return { types, typeIndex, x, y, yaw };
}
