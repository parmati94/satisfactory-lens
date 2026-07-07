import {
  isSaveComponent,
  isSaveEntity,
  isBoolProperty,
  isFloatProperty,
  isArrayProperty,
} from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const POWER_CIRCUIT_TYPE = '/Script/FactoryGame.FGPowerCircuit';

// Base MW per building class name. Generators are positive, consumers negative.
// Only includes buildings with non-zero power; poles/walls are omitted (skipped automatically).
const BASE_POWER_MW: Record<string, number> = {
  // Generators (positive = produces)
  Build_GeneratorBiomass_C:              30,
  Build_GeneratorBiomass_Automated_C:    30,
  Build_GeneratorIntegratedBiomass_C:    30,
  Build_GeneratorCoal_C:                 75,
  Build_GeneratorFuel_C:                250,   // 1.0 value (was 150 pre-1.0)
  Build_GeneratorNuclear_C:           2500,
  Build_GeneratorGeoThermal_C:          200,   // mid-range average

  // Miners & extractors (negative = consumes)
  Build_MinerMk1_C:              -5,
  Build_MinerMk2_C:             -12,
  Build_MinerMk3_C:             -30,
  Build_WaterPump_C:            -20,
  Build_OilPump_C:              -40,
  Build_FrackingSmasher_C:     -150,
  Build_FrackingExtractor_C:    -1,

  // Production buildings
  Build_ConstructorMk1_C:        -4,
  Build_SmelterMk1_C:            -4,
  Build_FoundryMk1_C:           -16,
  Build_AssemblerMk1_C:         -15,
  Build_ManufacturerMk1_C:      -55,
  Build_OilRefinery_C:          -30,
  Build_Packager_C:             -10,
  Build_Blender_C:              -75,
  Build_HadronCollider_C:     -1000,
  Build_QuantumEncoder_C:     -1000,
  Build_Converter_C:           -100,

  // Misc
  Build_ResourceSink_C:         -30,
  Build_RadarTower_C:           -50,
};

// Extract class name from a save pathName, e.g.:
// "Persistent_Level:PersistentLevel.Build_GeneratorBiomass_Automated_C_2146531368.PowerConnection"
// → instanceName: "Persistent_Level:PersistentLevel.Build_GeneratorBiomass_Automated_C_2146531368"
// → className:    "Build_GeneratorBiomass_Automated_C"
function parseComponentPath(pathName: string): { instanceName: string; className: string } | null {
  const dotIdx = pathName.indexOf('.');
  if (dotIdx < 0) return null;
  const prefix = pathName.slice(0, dotIdx); // "Persistent_Level:PersistentLevel"
  const rest = pathName.slice(dotIdx + 1);  // "Build_XYZ_C_123.PowerConnection"
  const secondDot = rest.indexOf('.');
  const instancePart = secondDot >= 0 ? rest.slice(0, secondDot) : rest;
  const instanceName = `${prefix}.${instancePart}`;
  const className = instancePart.replace(/_\d+$/, '');
  return { instanceName, className };
}

export interface PowerCircuit {
  circuitId: number;
  producedMW: number;   // actual production — only generators with fuel in inventory
  capacityMW: number;   // max potential — all generators at overclock regardless of fuel
  maxDrawMW: number;    // estimated max consumption — all consumers at overclock
  consumedMW: number;   // ACTUAL draw at save time — Σ each consumer's mTargetConsumption
  isFused: boolean;
}

export interface PowerSummary {
  circuits: PowerCircuit[];
  totalProducedMW: number;
  totalCapacityMW: number;
  totalMaxDrawMW: number;
  totalConsumedMW: number;
  fuseCount: number;
}

export function extractPower(save: SatisfactorySave): PowerSummary {
  // Build a single object map covering all entities and components
  const objectMap = new Map<string, any>();
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.instanceName) objectMap.set(obj.instanceName, obj);
    }
  }

  function getOverclock(instanceName: string): number {
    const obj = objectMap.get(instanceName);
    if (!obj || !isSaveEntity(obj)) return 1.0;
    const p = obj.properties?.['mCurrentPotential'];
    return p && isFloatProperty(p) ? p.value : 1.0;
  }

  // Actual power a building was drawing at save time, from its FGPowerInfo's
  // mTargetConsumption (e.g. 4 MW for a running constructor, 10 MW at 200%, ~0.1 MW
  // idle). Only consumers carry it — generators/poles return 0 — so summing it never
  // double-counts production. It's a snapshot of that exact tick.
  function getActualConsumption(instanceName: string): number {
    const entity = objectMap.get(instanceName);
    const piPath: string = entity?.properties?.['mPowerInfo']?.value?.pathName ?? '';
    if (!piPath) return 0;
    const tc = objectMap.get(piPath)?.properties?.['mTargetConsumption'];
    return tc && isFloatProperty(tc) ? Math.max(0, tc.value) : 0;
  }

  // Returns true if the generator has fuel loaded (or has no fuel inventory, e.g. geothermal).
  function generatorHasFuel(instanceName: string): boolean {
    const entity = objectMap.get(instanceName);
    if (!entity) return false;
    const fuelInvPath: string = entity.properties?.['mFuelInventory']?.value?.pathName ?? '';
    if (!fuelInvPath) return true; // no fuel inventory = always-on (geothermal)
    const fuelInv = objectMap.get(fuelInvPath);
    if (!fuelInv) return false;
    const stacks: any[] = fuelInv.properties?.['mInventoryStacks']?.values ?? [];
    return stacks.some((s: any) => (s.properties?.NumItems?.value ?? 0) > 0);
  }

  const circuits: PowerCircuit[] = [];

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath !== POWER_CIRCUIT_TYPE) continue;
      if (!isSaveComponent(obj)) continue;

      const idProp = obj.properties['mCircuitID'];
      const circuitId = idProp && 'value' in idProp && typeof idProp.value === 'number' ? idProp.value : 0;

      const fuseProp = obj.properties['mIsFuseTriggered'];
      const isFused = fuseProp && isBoolProperty(fuseProp) ? fuseProp.value : false;

      const componentsProp = obj.properties['mComponents'];

      let producedMW = 0;
      let capacityMW = 0;
      let maxDrawMW = 0;
      let consumedMW = 0;

      if (componentsProp && isArrayProperty(componentsProp)) {
        const seen = new Set<string>();

        for (const ref of componentsProp.values as Array<{ pathName?: string }>) {
          const pathName = ref?.pathName;
          if (!pathName) continue;

          const parsed = parseComponentPath(pathName);
          if (!parsed) continue;
          if (seen.has(parsed.instanceName)) continue;
          seen.add(parsed.instanceName);

          // Actual draw at save time — summed for every consumer on the circuit,
          // including ones we don't model a base power for (counted before the
          // BASE_POWER_MW gate below, which only feeds the theoretical estimates).
          consumedMW += getActualConsumption(parsed.instanceName);

          const baseMW = BASE_POWER_MW[parsed.className];
          if (baseMW === undefined) continue;

          const overclock = getOverclock(parsed.instanceName);
          const scaledMW = baseMW * overclock;

          if (scaledMW > 0) {
            capacityMW += scaledMW;
            if (generatorHasFuel(parsed.instanceName)) producedMW += scaledMW;
          } else {
            maxDrawMW += Math.abs(scaledMW);
          }
        }
      }

      circuits.push({ circuitId, producedMW, capacityMW, maxDrawMW, consumedMW, isFused });
    }
  }

  // Sort by circuit ID
  circuits.sort((a, b) => a.circuitId - b.circuitId);

  return {
    circuits,
    totalProducedMW: circuits.reduce((s, c) => s + c.producedMW, 0),
    totalCapacityMW: circuits.reduce((s, c) => s + c.capacityMW, 0),
    totalMaxDrawMW:  circuits.reduce((s, c) => s + c.maxDrawMW, 0),
    totalConsumedMW: circuits.reduce((s, c) => s + c.consumedMW, 0),
    fuseCount: circuits.filter(c => c.isFused).length,
  };
}
