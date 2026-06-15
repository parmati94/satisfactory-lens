import { Parser } from '@etothepii/satisfactory-file-parser';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

export interface InventoryItem {
  slotIndex: number;
  itemClass: string;   // e.g. "Desc_IronPlate"
  displayName: string; // e.g. "Iron Plate"
  count: number;
}

export interface StorageContainer {
  instanceName: string;
  label: string;
  position: { x: number; y: number; z: number } | null;
  totalSlots: number;
  usedSlots: number;   // non-empty slot count (before aggregation)
  contents: InventoryItem[];
}

// ── Label mapping ─────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  'Build_StorageContainerMk1': 'Storage Container Mk1',
  'Build_StorageContainerMk2': 'Storage Container Mk2',
  'Build_StoragePlayer':       'Personal Storage Box',
  'Build_StorageIntegrated':   'Integrated Storage',
  'BP_Crate':                  'Drop Pod / Crate',
};

function typeLabel(typePath: string): string {
  for (const [key, label] of Object.entries(TYPE_LABELS)) {
    if (typePath.includes(key)) return label;
  }
  const slug = typePath.split('/').pop()?.split('.')[0] ?? typePath;
  return slug.replace(/^Build_/, '').replace(/([A-Z])/g, ' $1').trim();
}

// ── Item name parsing ─────────────────────────────────────────────────────────

export function itemDisplayName(pathName: string): string {
  if (!pathName) return 'Unknown';
  // Format: "…/Desc_Foo.Desc_Foo_C" — take the part after the last dot
  const className = pathName.split('.').pop()?.replace(/_C$/, '') ?? '';
  const cleaned = className
    .replace(/^Desc_/, '')
    .replace(/^BP_EquipmentDescriptor/, '')
    .replace(/^BP_ItemDescriptor/, '')
    .replace(/^BP_/, '')
    .replace(/^Equip_/, '');
  // CamelCase → "Camel Case"
  return cleaned.replace(/([A-Z])/g, ' $1').trim() || className;
}

function itemClass(pathName: string): string {
  return pathName.split('.').pop()?.replace(/_C$/, '') ?? pathName;
}

// ── Inventory stack parsing ───────────────────────────────────────────────────

interface ParsedStacks {
  contents: InventoryItem[];
  usedSlots: number;
}

function parseStacks(entity: any): ParsedStacks {
  const stacks: any[] = entity?.properties?.mInventoryStacks?.values ?? [];
  const contents: InventoryItem[] = [];
  let usedSlots = 0;

  stacks.forEach((stack, idx) => {
    const count: number = stack.properties?.NumItems?.value ?? 0;
    if (count <= 0) return;
    const pathName: string = stack.properties?.Item?.value?.itemReference?.pathName ?? '';
    if (!pathName) return;
    usedSlots++;
    contents.push({
      slotIndex:   idx,
      itemClass:   itemClass(pathName),
      displayName: itemDisplayName(pathName),
      count,
    });
  });

  return { contents, usedSlots };
}

// ── Storage containers ────────────────────────────────────────────────────────

const STORAGE_TYPES = [
  'StorageContainerMk1',
  'StorageContainerMk2',
  'StoragePlayer',
  'StorageIntegrated',
  'BP_Crate',
];

export function extractStorage(save: SatisfactorySave): StorageContainer[] {
  // Build a lookup: instanceName → entity
  const byInstance = new Map<string, any>();
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.instanceName) byInstance.set(obj.instanceName, obj);
    }
  }

  const containers: StorageContainer[] = [];

  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      const tp = obj.typePath ?? '';
      if (!STORAGE_TYPES.some(t => tp.includes(t))) continue;

      // Resolve inventory component via mStorageInventory reference
      const invRef: string = (obj.properties as any)?.mStorageInventory?.value?.pathName ?? '';
      const invEntity = invRef ? byInstance.get(invRef) : null;

      // Total slots
      const totalSlots: number = invEntity?.properties?.mInventoryStacks?.values?.length ?? 0;

      // Position (cm → m)
      const t = (obj as any).transform?.translation;
      const position = t
        ? { x: Math.round(t.x / 100), y: Math.round(t.y / 100), z: Math.round(t.z / 100) }
        : null;

      const { contents, usedSlots } = parseStacks(invEntity);

      containers.push({
        instanceName: obj.instanceName,
        label:        typeLabel(tp),
        position,
        totalSlots,
        usedSlots,
        contents,
      });
    }
  }

  return containers;
}

// ── Player inventory (re-exported for use in players extractor) ───────────────

export function extractPlayerInventory(
  playerInstance: string,
  byInstance: Map<string, any>,
): { inventory: InventoryItem[]; equipment: InventoryItem[] } {
  const invKey  = `${playerInstance}.inventory`;
  const armKey  = `${playerInstance}.ArmSlot`;

  return {
    inventory: parseStacks(byInstance.get(invKey)).contents,
    equipment: parseStacks(byInstance.get(armKey)).contents,
  };
}

export function buildInstanceMap(save: SatisfactorySave): Map<string, any> {
  const map = new Map<string, any>();
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.instanceName) map.set(obj.instanceName, obj);
    }
  }
  return map;
}
