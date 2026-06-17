import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

const SCHEMATIC_MANAGER = 'BP_SchematicManager';

/** Find the schematic manager entity (holds mPurchasedSchematics), or null. */
export function findSchematicManager(save: SatisfactorySave): any | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if ((obj as any).typePath?.includes(SCHEMATIC_MANAGER)) return obj;
    }
  }
  return null;
}

/** The set of currently-purchased (unlocked) schematic path names. */
export function extractPurchasedSchematics(save: SatisfactorySave): string[] {
  const mgr = findSchematicManager(save);
  const values: any[] = mgr?.properties?.mPurchasedSchematics?.values ?? [];
  return values.map((v) => v?.pathName).filter((p): p is string => !!p);
}
