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
  inventoryName: string; // the inventory component entity — the edit target for slots
  label: string;
  buildClass: string;  // e.g. "Build_StorageContainerMk1" — used for icon lookup
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

export interface ParsedStacks {
  contents: InventoryItem[];
  usedSlots: number;
  totalSlots: number;
}

export function parseStacks(entity: any): ParsedStacks {
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

  return { contents, usedSlots, totalSlots: stacks.length };
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

      // Build class: last path segment without the _C suffix
      const buildClass = (tp.split('/').pop()?.split('.')[0] ?? '').replace(/_C$/, '');

      containers.push({
        instanceName: obj.instanceName,
        inventoryName: invRef,
        label:        typeLabel(tp),
        buildClass,
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
): { inventory: InventoryItem[]; inventorySlots: number; equipment: InventoryItem[]; equipmentSlots: number } {
  const invKey  = `${playerInstance}.inventory`;
  const armKey  = `${playerInstance}.ArmSlot`;

  const invStacks = parseStacks(byInstance.get(invKey));
  const armStacks = parseStacks(byInstance.get(armKey));

  return {
    inventory:      invStacks.contents,
    inventorySlots: invStacks.totalSlots,
    equipment:      armStacks.contents,
    equipmentSlots: armStacks.totalSlots,
  };
}

// ── Dimensional Depot (Central Storage) ───────────────────────────────────────
// Unlike a container, the depot isn't a slotted mInventoryStacks inventory — it's
// an ArrayProperty of ItemAmount structs (ItemClass + Amount) on the subsystem.

export interface DepotItem {
  itemClass: string;   // e.g. "Desc_IronPlate" (icon lookup)
  itemPath: string;    // full "/Game/…/Desc_X.Desc_X_C" path — the edit value
  displayName: string;
  amount: number;
}

export interface CentralStorage {
  instanceName: string; // subsystem entity — the edit target for depot items
  editable: boolean;    // mStoredItems already serialized → safe to add/edit in place
  items: DepotItem[];
}

const CENTRAL_STORAGE_TYPE = '/Script/FactoryGame.FGCentralStorageSubsystem';

export function extractCentralStorage(save: SatisfactorySave): CentralStorage | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath !== CENTRAL_STORAGE_TYPE) continue;
      const stored = (obj.properties as any)?.mStoredItems;
      const arr: any[] = stored?.values ?? [];
      const items: DepotItem[] = [];
      for (const entry of arr) {
        const path: string = entry?.properties?.ItemClass?.value?.pathName ?? '';
        if (!path) continue;
        items.push({
          itemClass: itemClass(path),
          itemPath: path,
          displayName: itemDisplayName(path),
          amount: entry?.properties?.Amount?.value ?? 0,
        });
      }
      items.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return { instanceName: obj.instanceName, editable: !!stored, items };
    }
  }
  return null;
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
