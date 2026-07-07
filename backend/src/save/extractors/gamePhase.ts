import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

// The Project Assembly / Space Elevator phases (0–7). These are FGGamePhase data
// assets, referenced WITHOUT the `_C` suffix (unlike Build_/Recipe_/Desc_ classes).
const PHASE_MGR_MARKER = 'BP_GamePhaseManager';
const GAME_STATE_MARKER = 'BP_GameState';
export const PHASE_COUNT = 8;
export function gamePhasePath(i: number): string {
  return `/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_${i}.GP_Project_Assembly_Phase_${i}`;
}

function parsePhaseIndex(pathName: string): number {
  const m = /Phase_(\d+)/.exec(pathName ?? '');
  return m ? parseInt(m[1], 10) : -1;
}

export interface GamePhaseInfo {
  target: string;       // FGGamePhaseManager instanceName — the edit target
  currentIndex: number; // 0..7, or -1 if it can't be parsed
  targetIndex: number;  // the phase being delivered toward (usually currentIndex + 1)
  count: number;
  // Space Elevator Deliverable Cost Multiplier (AGS). Scales base part costs.
  // Defaults to 1 and is omitted from the save when unchanged.
  costMultiplier: number;
  // Parts already delivered toward the target phase, keyed by short item class
  // (e.g. "Desc_SpaceElevatorPart_2"). From mTargetGamePhasePaidOffCosts.
  delivered: Record<string, number>;
}

// The AGS "Space Elevator Deliverable Cost Multiplier" lives on the game state as
// mSpacePartsCostMultiplier (FloatProperty). Absent when left at the 1× default.
function extractCostMultiplier(save: SatisfactorySave): number {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (!(obj.typePath ?? '').includes(GAME_STATE_MARKER)) continue;
      const v = (obj.properties as any)?.mSpacePartsCostMultiplier?.value;
      if (typeof v === 'number' && isFinite(v) && v > 0) return v;
      return 1;
    }
  }
  return 1;
}

export function extractGamePhase(save: SatisfactorySave): GamePhaseInfo | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (!(obj.typePath ?? '').includes(PHASE_MGR_MARKER)) continue;
      const props = obj.properties as any;
      const currentIndex = parsePhaseIndex(props?.mCurrentGamePhase?.value?.pathName);
      let targetIndex = parsePhaseIndex(props?.mTargetGamePhase?.value?.pathName);
      if (targetIndex < 0 && currentIndex >= 0) targetIndex = currentIndex + 1;

      // mTargetGamePhasePaidOffCosts: array of ItemAmount ({ ItemClass, Amount }),
      // progress toward the target phase. Omitted entirely when nothing delivered.
      const delivered: Record<string, number> = {};
      for (const it of props?.mTargetGamePhasePaidOffCosts?.values ?? []) {
        const path: string = it?.properties?.ItemClass?.value?.pathName ?? '';
        const amount: number = it?.properties?.Amount?.value ?? 0;
        const m = /([A-Za-z0-9_]+?)(?:_C)?$/.exec(path.split('.').pop() ?? '');
        if (m) delivered[m[1]] = amount;
      }

      return {
        target: obj.instanceName,
        currentIndex,
        targetIndex,
        count: PHASE_COUNT,
        costMultiplier: extractCostMultiplier(save),
        delivered,
      };
    }
  }
  return null;
}
