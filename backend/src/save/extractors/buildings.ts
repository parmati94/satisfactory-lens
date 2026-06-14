import { isSaveEntity } from '@etothepii/satisfactory-file-parser';
import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

// Well-known type path prefixes / suffixes for display labels
const BUILDABLE_PREFIX = '/Game/FactoryGame/Buildable/';

// Strip the UE asset path down to a readable label, e.g.
// "/Game/FactoryGame/Buildable/Factory/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C"
// → "Smelter Mk1"
function buildingLabel(typePath: string): string {
  const dot = typePath.lastIndexOf('.');
  const segment = dot >= 0 ? typePath.slice(dot + 1) : typePath.split('/').pop() ?? typePath;
  return segment
    .replace(/_C$/, '')
    .replace(/^Build_/, '')
    .replace(/Mk(\d)/g, ' Mk$1')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

export interface BuildingCount {
  label: string;
  typePath: string;
  count: number;
}

export interface BuildingSummary {
  totalBuildings: number;
  topTypes: BuildingCount[];
}

export function extractBuildings(save: SatisfactorySave): BuildingSummary {
  const counts = new Map<string, { label: string; typePath: string; count: number }>();

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (!obj.typePath.startsWith(BUILDABLE_PREFIX)) continue;
      if (!isSaveEntity(obj)) continue;

      const existing = counts.get(obj.typePath);
      if (existing) {
        existing.count++;
      } else {
        counts.set(obj.typePath, {
          label: buildingLabel(obj.typePath),
          typePath: obj.typePath,
          count: 1,
        });
      }
    }
  }

  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const totalBuildings = sorted.reduce((sum, b) => sum + b.count, 0);

  return {
    totalBuildings,
    topTypes: sorted.slice(0, 25),
  };
}
