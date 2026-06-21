import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

// The Project Assembly / Space Elevator phases (0–7). These are FGGamePhase data
// assets, referenced WITHOUT the `_C` suffix (unlike Build_/Recipe_/Desc_ classes).
const PHASE_MGR_MARKER = 'BP_GamePhaseManager';
export const PHASE_COUNT = 8;
export function gamePhasePath(i: number): string {
  return `/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_${i}.GP_Project_Assembly_Phase_${i}`;
}

export interface GamePhaseInfo {
  target: string;       // FGGamePhaseManager instanceName — the edit target
  currentIndex: number; // 0..7, or -1 if it can't be parsed
  count: number;
}

export function extractGamePhase(save: SatisfactorySave): GamePhaseInfo | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (!(obj.typePath ?? '').includes(PHASE_MGR_MARKER)) continue;
      const cur: string = (obj.properties as any)?.mCurrentGamePhase?.value?.pathName ?? '';
      const m = /Phase_(\d+)/.exec(cur);
      return { target: obj.instanceName, currentIndex: m ? parseInt(m[1], 10) : -1, count: PHASE_COUNT };
    }
  }
  return null;
}
