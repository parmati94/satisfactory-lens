import { isSaveEntity } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { readFileSync } from 'fs';
import { join } from 'path';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

// Loaded once at module init — maps Build_ClassName → human-readable display name
let _nameMap: Record<string, string> | null = null;
function getNameMap(): Record<string, string> {
  if (!_nameMap) {
    try {
      const p = join(__dirname, '../../../data/buildable_names.json');
      _nameMap = JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      _nameMap = {};
    }
  }
  return _nameMap!;
}

const BUILDABLE_PREFIX = '/Game/FactoryGame/Buildable/';

// Map the 3rd path segment (subfolder within Factory/ or Building/) → category label.
// Path format: /Game/FactoryGame/Buildable/<topLevel>/<subfolder>/Build_X.Build_X_C
const SUBFOLDER_CATEGORY: Record<string, string> = {
  // ── Production ──────────────────────────────────────────────────────────
  SmelterMk1:           'Production',
  FoundryMk1:           'Production',
  ConstructorMk1:       'Production',
  AssemblerMk1:         'Production',
  ManufacturerMk1:      'Production',
  OilRefinery:          'Production',
  Packager:             'Production',
  Blender:              'Production',
  HadronCollider:       'Production',
  QuantumEncoder:       'Production',
  Converter:            'Production',

  // ── Miners & Extractors ─────────────────────────────────────────────────
  MinerMK1:             'Miners & Extractors',
  MinerMk2:             'Miners & Extractors',
  MinerMk3:             'Miners & Extractors',
  WaterPump:            'Miners & Extractors',
  OilPump:              'Miners & Extractors',
  FrackingSmasher:      'Miners & Extractors',
  FrackingExtractor:    'Miners & Extractors',

  // ── Power Generation ────────────────────────────────────────────────────
  GeneratorBiomass:     'Power',
  GeneratorCoal:        'Power',
  GeneratorFuel:        'Power',
  GeneratorGeoThermal:  'Power',
  GeneratorNuclear:     'Power',
  AlienPower:           'Power',
  PowerStorage:         'Power',

  // ── Power Infrastructure ────────────────────────────────────────────────
  PowerPoleMk1:             'Power Infrastructure',
  PowerPoleMk2:             'Power Infrastructure',
  PowerPoleMk3:             'Power Infrastructure',
  PowerPoleWall:            'Power Infrastructure',
  PowerPoleWallDouble:      'Power Infrastructure',
  PowerTower:               'Power Infrastructure',
  PowerLine:                'Power Infrastructure',
  PowerSwitch:              'Power Infrastructure',
  SmartPowerSwitch:         'Power Infrastructure',
  PriorityPowerSwitch:      'Power Infrastructure',

  // ── Conveyors & Belts ───────────────────────────────────────────────────
  ConveyorBeltMk1:              'Conveyors & Belts',
  ConveyorBeltMk2:              'Conveyors & Belts',
  ConveyorBeltMk3:              'Conveyors & Belts',
  ConveyorBeltMk4:              'Conveyors & Belts',
  ConveyorBeltMk5:              'Conveyors & Belts',
  ConveyorBeltMk6:              'Conveyors & Belts',
  ConveyorLiftMk1:              'Conveyors & Belts',
  ConveyorLiftMk2:              'Conveyors & Belts',
  ConveyorLiftMk3:              'Conveyors & Belts',
  ConveyorLiftMk4:              'Conveyors & Belts',
  ConveyorLiftMk5:              'Conveyors & Belts',
  ConveyorLiftMk6:              'Conveyors & Belts',
  ConveyorFloorHole:            'Conveyors & Belts',
  ConveyorPole:                 'Conveyors & Belts',
  ConveyorPoleMulti:            'Conveyors & Belts',
  ConveyorPoleStackable:        'Conveyors & Belts',
  ConveyorPoleWall:             'Conveyors & Belts',
  ConveyorMonitor:              'Conveyors & Belts',
  ConveyorThroughputDisplay:    'Conveyors & Belts',
  CA_Merger:                    'Conveyors & Belts',
  CA_MergerLift:                'Conveyors & Belts',
  CA_MergerLiftPriority:        'Conveyors & Belts',
  CA_MergerPriority:            'Conveyors & Belts',
  CA_Splitter:                  'Conveyors & Belts',
  CA_SplitterLift:              'Conveyors & Belts',
  CA_SplitterLiftProgrammable:  'Conveyors & Belts',
  CA_SplitterLiftSmart:         'Conveyors & Belts',
  CA_SplitterProgrammable:      'Conveyors & Belts',
  CA_SplitterSmart:             'Conveyors & Belts',

  // ── Pipes & Fluids ──────────────────────────────────────────────────────
  Pipeline:                     'Pipes & Fluids',
  PipelineMk2:                  'Pipes & Fluids',
  PipelineSupport:              'Pipes & Fluids',
  PipelineSupportWall:          'Pipes & Fluids',
  PipelineSupportWallHole:      'Pipes & Fluids',
  PipeJunction:                 'Pipes & Fluids',
  PipePole:                     'Pipes & Fluids',
  PipePump:                     'Pipes & Fluids',
  PipePumpMk2:                  'Pipes & Fluids',
  PipeValve:                    'Pipes & Fluids',
  FluidContainer:               'Pipes & Fluids',
  IndustrialFluidContainer:     'Pipes & Fluids',
  StorageTank:                  'Pipes & Fluids',

  // ── Hypertubes ──────────────────────────────────────────────────────────
  PipeHyper:            'Hypertubes',
  PipeHyperJunction:    'Hypertubes',
  PipeHyperStart:       'Hypertubes',
  PipeHyperSupport:     'Hypertubes',
  PipeHyperTJunction:   'Hypertubes',
  HyperTubeWallSupport: 'Hypertubes',

  // ── Trains & Rails ──────────────────────────────────────────────────────
  Train:          'Trains & Rails',
  TrainStation:   'Trains & Rails',
  TrainSignalType1: 'Trains & Rails',
  TrainSignalType2: 'Trains & Rails',
  TrainSwitch:    'Trains & Rails',
  RailwayEndStop: 'Trains & Rails',

  // ── Logistics ───────────────────────────────────────────────────────────
  TruckStation:   'Logistics',
  DroneStation:   'Logistics',
  LandingPad:     'Logistics',
  Elevator:       'Logistics',

  // ── Storage ─────────────────────────────────────────────────────────────
  StorageContainerMk1: 'Storage',
  StorageContainerMk2: 'Storage',
  StoragePlayer:       'Storage',
  CentralStorage:      'Storage',
  Locker:              'Storage',

  // ── Lights ──────────────────────────────────────────────────────────────
  CeilingLight:       'Lights',
  Floodlight:         'Lights',
  LightsControlPanel: 'Lights',
  StreetLight:        'Lights',

  // ── Signs & Displays ────────────────────────────────────────────────────
  SignDigital:    'Signs & Displays',
  SignPole:       'Signs & Displays',
  StandaloneSign: 'Signs & Displays',
  RadarTower:     'Signs & Displays',

  // ── Workbenches & Research ──────────────────────────────────────────────
  WorkBench:           'Workbenches & Research',
  Workshop:            'Workbenches & Research',
  AutomatedWorkBench:  'Workbenches & Research',
  MAM:                 'Workbenches & Research',
  Mam:                 'Workbenches & Research',

  // ── HUB & Milestones ────────────────────────────────────────────────────
  HubTerminal:    'HUB & Milestones',
  TradingPost:    'HUB & Milestones',
  SpaceElevator:  'HUB & Milestones',
  ProjectAssembly:'HUB & Milestones',
  ResourceSink:   'HUB & Milestones',
  ResourceSinkShop:'HUB & Milestones',

  // ── Foundations ─────────────────────────────────────────────────────────
  Foundation:          'Foundations',
  Floor:               'Foundations',
  FoundationPassthrough:'Foundations',
  CornerBlock:         'Foundations',
  ConveyorHole:        'Foundations',   // Building/ConveyorHole

  // ── Walls ───────────────────────────────────────────────────────────────
  Wall:   'Walls',
  Fence:  'Walls',
  TarpFence: 'Walls',
  Doors:  'Walls',

  // ── Ramps ───────────────────────────────────────────────────────────────
  Ramp: 'Ramps',

  // ── Stairs ──────────────────────────────────────────────────────────────
  Stair:  'Stairs & Walkways',
  Walkway:'Stairs & Walkways',
  Catwalk:'Stairs & Walkways',
  Ladder: 'Stairs & Walkways',

  // ── Roofs & Pillars ─────────────────────────────────────────────────────
  Roof:    'Roofs & Pillars',
  Pillars: 'Roofs & Pillars',

  // ── Decor ───────────────────────────────────────────────────────────────
  Decor:         'Decor',
  Holiday:       'Decor',
  StackableShelf:'Decor',
  Vent:          'Decor',
  LargeFan:      'Decor',
  JumpPad:       'Decor',
  Barrier:       'Decor',

  // ── Miscellaneous ───────────────────────────────────────────────────────
  Potty:            'Miscellaneous',
  PortalPotty:      'Miscellaneous',
  Portal:           'Miscellaneous',
  LookoutTower:     'Miscellaneous',
  BlueprintDesigner:'Miscellaneous',
};

const CATEGORY_ORDER: Record<string, number> = {
  'Production':           1,
  'Miners & Extractors':  2,
  'Power':                3,
  'Power Infrastructure': 4,
  'Conveyors & Belts':    5,
  'Pipes & Fluids':       6,
  'Hypertubes':           7,
  'Trains & Rails':       8,
  'Logistics':            9,
  'Storage':              10,
  'Foundations':          11,
  'Walls':                12,
  'Ramps':                13,
  'Stairs & Walkways':    14,
  'Roofs & Pillars':      15,
  'Lights':               16,
  'Signs & Displays':     17,
  'Workbenches & Research': 18,
  'HUB & Milestones':     19,
  'Decor':                20,
  'Miscellaneous':        98,
  'Other':                99,
};

export function categoryFromTypePath(typePath: string): string {
  // e.g. /Game/FactoryGame/Buildable/Factory/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C
  const rest = typePath.slice(BUILDABLE_PREFIX.length);   // Factory/SmelterMk1/Build_...
  const segments = rest.split('/');
  const subfolder = segments[1] ?? '';                     // SmelterMk1
  return SUBFOLDER_CATEGORY[subfolder] ?? `Other (${segments[0]})`;
}

export function buildClassFromTypePath(typePath: string): string {
  // e.g. ".../Build_SmelterMk1.Build_SmelterMk1_C" → "Build_SmelterMk1"
  return (typePath.split('.')[0]).split('/').pop() ?? '';
}

export function buildingLabel(typePath: string): string {
  const cls = buildClassFromTypePath(typePath);
  const mapped = getNameMap()[cls];
  if (mapped) return mapped;
  // Fallback: derive from class name
  return cls
    .replace(/^Build_/i, '')
    .replace(/_0\d$/, '')        // strip trailing variant suffix: _01, _02, etc.
    .replace(/Mk(\d)/g, ' Mk$1')
    .replace(/_(\d)/g, ' $1')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface BuildingInstance {
  pos: Vec3;
  rot: Quat;
}

export interface BuildingCount {
  buildClass: string;
  label: string;
  typePath: string;
  count: number;
  instances: BuildingInstance[];
}

export interface BuildingCategory {
  key: string;
  category: string;
  total: number;
  types: BuildingCount[];
}

export interface BuildingSummary {
  totalBuildings: number;
  productionCount: number;
  powerCount: number;
  categories: BuildingCategory[];
}

type BuildingEntry = { buildClass: string; label: string; typePath: string; category: string; count: number; instances: BuildingInstance[] };

function addCount(counts: Map<string, BuildingEntry>, typePath: string, instance: BuildingInstance) {
  const existing = counts.get(typePath);
  if (existing) {
    existing.count++;
    existing.instances.push(instance);
  } else {
    counts.set(typePath, {
      buildClass: buildClassFromTypePath(typePath),
      label:      buildingLabel(typePath),
      typePath,
      category:   categoryFromTypePath(typePath),
      count: 1,
      instances: [instance],
    });
  }
}

function transformFromRaw(t: any): BuildingInstance {
  return {
    pos: { x: t?.translation?.x ?? 0, y: t?.translation?.y ?? 0, z: t?.translation?.z ?? 0 },
    rot: { x: t?.rotation?.x ?? 0, y: t?.rotation?.y ?? 0, z: t?.rotation?.z ?? 0, w: t?.rotation?.w ?? 1 },
  };
}

/**
 * Walk every buildable instance in the save (both normal/heavy buildables and
 * lightweight ones — foundations, walls, ramps, etc. stored in
 * FGLightweightBuildableSubsystem) and invoke `cb` with its typePath + transform.
 * Shared by extractBuildings (tab summary) and extractBuildingFootprints (map).
 */
export function forEachBuildingInstance(
  save: SatisfactorySave,
  cb: (typePath: string, instance: BuildingInstance, obj?: any) => void,
): void {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      // ── Normal (heavy) buildables ───────────────────────────────────────
      // Pass the raw object too, so callers can reach properties like
      // mSplineData (belts/pipes) — lightweight buildables have no such data.
      if (obj.typePath.startsWith(BUILDABLE_PREFIX) && isSaveEntity(obj)) {
        cb(obj.typePath, transformFromRaw((obj as any).transform), obj);
        continue;
      }

      // ── Lightweight buildables (foundations, walls, ramps, etc.) ────────
      // Stored in FGLightweightBuildableSubsystem.specialProperties
      if (obj.typePath === '/Script/FactoryGame.FGLightweightBuildableSubsystem') {
        const sp = (obj as any).specialProperties;
        if (sp?.type === 'BuildableSubsystemSpecialProperties') {
          for (const buildable of (sp.buildables as any[])) {
            const tp: string = buildable.typeReference?.pathName ?? '';
            if (!tp || !tp.startsWith(BUILDABLE_PREFIX)) continue;
            for (const inst of (buildable.instances as any[])) {
              cb(tp, transformFromRaw(inst.transform));
            }
          }
        }
        continue;
      }
    }
  }
}

export function extractBuildings(save: SatisfactorySave): BuildingSummary {
  const counts = new Map<string, BuildingEntry>();

  forEachBuildingInstance(save, (typePath, instance) => addCount(counts, typePath, instance));

  // Group by category
  const catMap = new Map<string, BuildingCategory>();
  for (const entry of counts.values()) {
    let cat = catMap.get(entry.category);
    if (!cat) {
      cat = { key: entry.category, category: entry.category, total: 0, types: [] };
      catMap.set(entry.category, cat);
    }
    cat.total += entry.count;
    cat.types.push({ buildClass: entry.buildClass, label: entry.label, typePath: entry.typePath, count: entry.count, instances: entry.instances });
  }

  for (const cat of catMap.values()) {
    cat.types.sort((a, b) => b.count - a.count);
  }

  const categories = Array.from(catMap.values()).sort((a, b) => {
    const orderA = CATEGORY_ORDER[a.category] ?? 98;
    const orderB = CATEGORY_ORDER[b.category] ?? 98;
    if (orderA !== orderB) return orderA - orderB;
    return b.total - a.total;
  });

  const totalBuildings = categories.reduce((s, c) => s + c.total, 0);
  const productionCount = catMap.get('Production')?.total ?? 0;
  const powerCount = catMap.get('Power')?.total ?? 0;

  return { totalBuildings, productionCount, powerCount, categories };
}
