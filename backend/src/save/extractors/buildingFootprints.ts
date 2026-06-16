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
