import { isSaveEntity, isFloatProperty } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const EXTRACTOR_TYPES: Record<string, string> = {
  '/Game/FactoryGame/Buildable/Factory/MinerMK1/Build_MinerMk1.Build_MinerMk1_C':                       'Miner Mk.1',
  '/Game/FactoryGame/Buildable/Factory/MinerMk2/Build_MinerMk2.Build_MinerMk2_C':                       'Miner Mk.2',
  '/Game/FactoryGame/Buildable/Factory/MinerMk3/Build_MinerMk3.Build_MinerMk3_C':                       'Miner Mk.3',
  '/Game/FactoryGame/Buildable/Factory/WaterPump/Build_WaterPump.Build_WaterPump_C':                     'Water Extractor',
  '/Game/FactoryGame/Buildable/Factory/OilPump/Build_OilPump.Build_OilPump_C':                           'Oil Extractor',
  '/Game/FactoryGame/Buildable/Factory/FrackingSmasher/Build_FrackingSmasher.Build_FrackingSmasher_C':   'Resource Well Pressurizer',
  '/Game/FactoryGame/Buildable/Factory/FrackingExtractor/Build_FrackingExtractor.Build_FrackingExtractor_C': 'Resource Well Extractor',
};

export interface ExtractorGroup {
  label: string;
  typePath: string;
  count: number;
  avgOverclockPct: number;
}

export interface ResourceSummary {
  totalExtractors: number;
  groups: ExtractorGroup[];
}

export function extractResources(save: SatisfactorySave): ResourceSummary {
  const groups = new Map<string, { label: string; count: number; overclockSum: number }>();

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      const label = EXTRACTOR_TYPES[obj.typePath];
      if (!label) continue;
      if (!isSaveEntity(obj)) continue;

      const potentialProp = obj.properties['mCurrentPotential'];
      const overclock = potentialProp && isFloatProperty(potentialProp) ? potentialProp.value : 1.0;

      const existing = groups.get(obj.typePath);
      if (existing) {
        existing.count++;
        existing.overclockSum += overclock;
      } else {
        groups.set(obj.typePath, { label, count: 1, overclockSum: overclock });
      }
    }
  }

  const result: ExtractorGroup[] = Array.from(groups.entries()).map(([typePath, g]) => ({
    typePath,
    label: g.label,
    count: g.count,
    avgOverclockPct: Math.round((g.overclockSum / g.count) * 100),
  }));

  // Sort: miners first (by mk), then others alphabetically
  const ORDER = ['Miner Mk.1', 'Miner Mk.2', 'Miner Mk.3', 'Oil Extractor', 'Water Extractor', 'Resource Well Pressurizer', 'Resource Well Extractor'];
  result.sort((a, b) => {
    const ai = ORDER.indexOf(a.label);
    const bi = ORDER.indexOf(b.label);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  return {
    totalExtractors: result.reduce((sum, g) => sum + g.count, 0),
    groups: result,
  };
}
