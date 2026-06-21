import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { getSave, getSaveStatus, setSave } from './saveState';
import { findSchematicManager } from './extractors/schematics';
import { gamePhasePath, PHASE_COUNT } from './extractors/gamePhase';
import { getSaveSourceMode, findLatestApiSave } from './loader';
import { config } from '../config';
import { uploadSavegame, isConnected } from '../api/sfClient';

type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

// A single staged edit from the client's override dictionary. `kind` selects the
// mutator; `target` is a stable address (here: a player instanceName); `value`
// is the absolute new value (set-semantics → idempotent, so re-applying is safe).
export interface SaveEdit {
  kind: string;
  target: string;
  value: unknown;
}

// ── Mutators (the per-edit-kind catalog) ────────────────────────────────────
// Keep this small and explicit — one mutator per edit kind, never a generic
// "set any path". Each maps an override onto an exact change in the parsed save.

function findEntity(save: SatisfactorySave, instanceName: string): any | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if ((obj as any).instanceName === instanceName) return obj;
    }
  }
  return null;
}

function applySetPlayerPosition(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as { x: number; y: number; z: number };
  if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
    throw new Error(`SetPlayerPosition: invalid value for ${edit.target}`);
  }
  const obj = findEntity(save, edit.target);
  if (!obj || !obj.transform?.translation) {
    throw new Error(`SetPlayerPosition: player not found or has no transform (${edit.target})`);
  }
  obj.transform.translation.x = v.x;
  obj.transform.translation.y = v.y;
  obj.transform.translation.z = v.z;
}

// Set (or clear) one inventory slot. value: { slot, item, count }. `item` is the
// full item path (/Game/...Desc_X_C) or null/empty to clear. Empty and filled
// slots share the same structure in the save, so we only set pathName + NumItems.
function applySetInventorySlot(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as { slot: number; item: string | null; count: number };
  if (!v || typeof v.slot !== 'number') {
    throw new Error(`SetInventorySlot: invalid value for ${edit.target}`);
  }
  const obj = findEntity(save, edit.target);
  const stacks = obj?.properties?.mInventoryStacks?.values;
  if (!Array.isArray(stacks)) {
    throw new Error(`SetInventorySlot: inventory not found (${edit.target})`);
  }
  const stack = stacks[v.slot];
  const itemRef = stack?.properties?.Item?.value?.itemReference;
  if (!itemRef || !stack?.properties?.NumItems) {
    throw new Error(`SetInventorySlot: slot ${v.slot} not editable (${edit.target})`);
  }
  if (!v.item || !(v.count > 0)) {
    itemRef.pathName = '';
    itemRef.levelName = '';
    stack.properties.NumItems.value = 0;
  } else {
    itemRef.pathName = v.item;
    stack.properties.NumItems.value = Math.round(v.count);
  }
}

// Set a player's current health. target: player instanceName, value: number (HP).
// Health lives on the linked FGHealthComponent; mCurrentHealth may be absent at
// full health, so we create the FloatProperty if needed.
function applySetPlayerHealth(save: SatisfactorySave, edit: SaveEdit): void {
  const hp = edit.value as number;
  if (typeof hp !== 'number' || !isFinite(hp)) {
    throw new Error(`SetPlayerHealth: invalid value for ${edit.target}`);
  }
  const player = findEntity(save, edit.target);
  const hcRef = player?.properties?.mHealthComponent?.value?.pathName;
  const hc = hcRef ? findEntity(save, hcRef) : null;
  if (!hc) throw new Error(`SetPlayerHealth: health component not found for ${edit.target}`);
  if (!hc.properties) hc.properties = {};
  let prop = hc.properties.mCurrentHealth;
  if (!prop) {
    prop = { type: 'FloatProperty', name: 'mCurrentHealth', propertyTagType: { name: 'FloatProperty', children: [] }, value: 0 };
    hc.properties.mCurrentHealth = prop;
  }
  prop.value = Math.max(0, hp);
}

// Unlock/re-lock a schematic. target: schematic pathName, value: { purchased: bool }.
function applySetSchematicPurchased(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as { purchased: boolean };
  const path = edit.target;
  const mgr = findSchematicManager(save);
  const arr = mgr?.properties?.mPurchasedSchematics?.values;
  if (!Array.isArray(arr)) throw new Error('SetSchematicPurchased: schematic manager not found');
  const idx = arr.findIndex((r: any) => r?.pathName === path);
  if (v?.purchased) {
    if (idx === -1) arr.push({ levelName: '', pathName: path });
  } else if (idx !== -1) {
    arr.splice(idx, 1);
  }
}

// Set the stored amount of one item in the Dimensional Depot (Central Storage).
// target: the FGCentralStorageSubsystem instanceName. value: { item, amount }, where
// `item` is the full item path; amount<=0 removes the entry. The depot is an
// ArrayProperty of ItemAmount structs keyed by ItemClass — not a slotted inventory.
function makeItemAmount(itemPath: string, amount: number): any {
  return {
    type: 'ItemAmount',
    properties: {
      ItemClass: {
        type: 'ObjectProperty', name: 'ItemClass',
        propertyTagType: { name: 'ObjectProperty', children: [] },
        value: { levelName: '', pathName: itemPath },
      },
      Amount: {
        type: 'IntProperty', name: 'Amount',
        propertyTagType: { name: 'IntProperty', children: [] },
        value: amount,
      },
    },
  };
}

// Build the mStoredItems ArrayProperty from scratch (depots that have never been
// used don't serialize it). binarySize is recomputed by WriteSave, so 0 is fine.
function makeStoredItemsArray(): any {
  const tag = { name: 'StructProperty', children: [{ name: 'ItemAmount', children: [] }] };
  return {
    type: 'ArrayProperty', name: 'mStoredItems',
    propertyTagType: { name: 'ArrayProperty', children: [tag] },
    structTag: {
      propertyName: 'mStoredItems', binarySize: 0,
      propertyTagType: tag, propertyType: 'StructProperty',
      index: 0, subtype: 'ItemAmount', structGuid: [0, 0, 0, 0],
    },
    values: [],
  };
}

function applySetDepotItem(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as { item: string; amount: number };
  if (!v || typeof v.item !== 'string' || !v.item) {
    throw new Error(`SetDepotItem: invalid value for ${edit.target}`);
  }
  const sub = findEntity(save, edit.target);
  if (!sub?.properties) throw new Error(`SetDepotItem: central storage not found (${edit.target})`);
  const amount = Math.max(0, Math.round(v.amount));
  // Synthesize the stored-items array on first use (never-used depots omit it).
  if (!Array.isArray(sub.properties.mStoredItems?.values)) {
    if (amount <= 0) return; // nothing to remove from an absent array
    sub.properties.mStoredItems = makeStoredItemsArray();
  }
  const arr = sub.properties.mStoredItems.values;
  const idx = arr.findIndex((e: any) => e?.properties?.ItemClass?.value?.pathName === v.item);
  if (amount <= 0) {
    if (idx !== -1) arr.splice(idx, 1);
  } else if (idx !== -1) {
    arr[idx].properties.Amount.value = amount;
  } else {
    arr.push(makeItemAmount(v.item, amount));
  }
}

// ── Machine overclock + recipe ──────────────────────────────────────────────
const POWER_SHARD = '/Game/FactoryGame/Resource/Environment/Crystal/Desc_CrystalShard.Desc_CrystalShard_C';
const SOMERSLOOP  = '/Game/FactoryGame/Prototype/WAT/Desc_WAT1.Desc_WAT1_C';

// One empty inventory slot (the shape the parser emits for an unfilled stack).
function makeInventoryStack(): any {
  return {
    type: 'InventoryStack',
    properties: {
      Item: {
        type: 'StructProperty', name: 'Item',
        propertyTagType: { name: 'StructProperty', children: [{ name: 'InventoryItem', children: [] }] },
        value: { itemReference: { levelName: '', pathName: '' }, itemState: { hasValidStruct: false } },
      },
      NumItems: {
        type: 'IntProperty', name: 'NumItems',
        propertyTagType: { name: 'IntProperty', children: [] },
        value: 0,
      },
    },
  };
}

// Build an mInventoryStacks ArrayProperty of N empty slots (for pristine extractor
// potential inventories that serialize only mArbitrarySlotSizes). binarySize is
// recomputed by WriteSave, so 0 is fine.
function makeInventoryStacksArray(slots: number): any {
  const tag = { name: 'StructProperty', children: [{ name: 'InventoryStack', children: [] }] };
  return {
    type: 'ArrayProperty', name: 'mInventoryStacks',
    propertyTagType: { name: 'ArrayProperty', children: [tag] },
    structTag: {
      propertyName: 'mInventoryStacks', binarySize: 0,
      propertyTagType: tag, propertyType: 'StructProperty',
      index: 0, subtype: 'InventoryStack', structGuid: [0, 0, 0, 0],
    },
    values: Array.from({ length: slots }, () => makeInventoryStack()),
  };
}

// Set a production machine's overclock and keep its Power Shards consistent.
// target: machine instanceName. value: clock as a fraction (1 = 100%, max 2.5).
// >100% is backed by shards in mInventoryPotential (each shard = +50%, max 3); we
// fill the leading shard slots and never disturb a somersloop (Desc_WAT1) slot.
function applySetMachineClock(save: SatisfactorySave, edit: SaveEdit): void {
  const raw = edit.value as number;
  if (typeof raw !== 'number' || !isFinite(raw)) {
    throw new Error(`SetMachineClock: invalid value for ${edit.target}`);
  }
  const clock = Math.max(0.01, Math.min(2.5, raw));
  const machine = findEntity(save, edit.target);
  if (!machine?.properties) throw new Error(`SetMachineClock: machine not found (${edit.target})`);

  // 1) Set/create mCurrentPotential (absent at default 100%, like health). Keep
  //    mPendingPotential in lock-step so the value doesn't snap back on resolve.
  let prop = machine.properties.mCurrentPotential;
  if (!prop) {
    prop = { type: 'FloatProperty', name: 'mCurrentPotential', propertyTagType: { name: 'FloatProperty', children: [] }, value: 1 };
    machine.properties.mCurrentPotential = prop;
  }
  prop.value = clock;
  if (machine.properties.mPendingPotential) machine.properties.mPendingPotential.value = clock;

  // 2) Reconcile shards. Each Power Shard raises the clock CAP by +50% (0 shards =
  //    100%), so any overclock above 100% needs ⌈(pct−100)/50⌉ shards: 101–150 → 1,
  //    151–200 → 2, 201–250 → 3. Computed from the integer percent to dodge float
  //    edges. Production machines keep a fully-serialized potential inventory with
  //    writable slots; pristine extractors (never-touched miners) carry only
  //    mArbitrarySlotSizes, so synthesize the shard slots.
  const pct = Math.round(clock * 100);
  const shardCount = pct <= 100 ? 0 : Math.min(3, Math.ceil((pct - 100) / 50));
  const invRef = machine.properties.mInventoryPotential?.value?.pathName;
  const invEntity = invRef ? findEntity(save, invRef) : null;
  let stacks = invEntity?.properties?.mInventoryStacks?.values;
  if (!Array.isArray(stacks)) {
    if (shardCount <= 0) return; // ≤100% with no shard slots: clock set, nothing to place
    if (!invEntity?.properties) throw new Error(`SetMachineClock: no potential inventory (${edit.target})`);
    const slots = Math.max(invEntity.properties.mArbitrarySlotSizes?.values?.length || 3, shardCount);
    invEntity.properties.mInventoryStacks = makeInventoryStacksArray(slots);
    stacks = invEntity.properties.mInventoryStacks.values;
  }
  let placed = 0;
  for (const stack of stacks) {
    const itemRef = stack?.properties?.Item?.value?.itemReference;
    const num = stack?.properties?.NumItems;
    if (!itemRef || !num) continue;
    if (itemRef.pathName === SOMERSLOOP) continue;      // never touch somersloop slots
    if (placed < shardCount) {
      itemRef.pathName = POWER_SHARD; itemRef.levelName = ''; num.value = 1; placed++;
    } else if (itemRef.pathName === POWER_SHARD) {
      itemRef.pathName = ''; itemRef.levelName = ''; num.value = 0; // clear surplus on downclock
    }
  }
  if (placed < shardCount) throw new Error(`SetMachineClock: not enough shard slots for ${Math.round(clock * 100)}% (${edit.target})`);
}

// ── Map markers (player-placed stamps on FGMapManager) ──────────────────────
function findMapManager(save: SatisfactorySave): any | null {
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if ((obj as any).typePath === '/Script/FactoryGame.FGMapManager') return obj;
    }
  }
  return null;
}

// Markers are matched by markerGuid (joined) — order-independent, so a batch of
// renames/deletes never collides via shifting array indices.
function findMarker(save: SatisfactorySave, guid: string): { arr: any[] | null; idx: number } {
  const arr = findMapManager(save)?.properties?.mMapMarkers?.values;
  if (!Array.isArray(arr)) return { arr: null, idx: -1 };
  const idx = arr.findIndex((m: any) => (m?.properties?.markerGuid?.value as number[] | undefined)?.join('-') === guid);
  return { arr, idx };
}

// sRGB byte (0–255) → linear float (0–1); inverse of the extractor's display gamma.
function srgbToLinear(c: number): number {
  return Math.pow(Math.max(0, Math.min(255, c)) / 255, 2.2);
}

// Edit a marker's name / color / icon / position. value carries only the changed
// fields. target: markerGuid (joined). Color arrives as sRGB 0–255.
function applySetMapMarker(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as {
    name?: string; color?: { r: number; g: number; b: number };
    iconId?: number; position?: { x: number; y: number; z: number };
  };
  const { arr, idx } = findMarker(save, edit.target);
  if (!arr || idx === -1) throw new Error(`SetMapMarker: marker not found (${edit.target})`);
  const props = arr[idx].properties;
  if (typeof v.name === 'string' && props.Name) props.Name.value = v.name;
  if (v.color && props.Color?.value) {
    props.Color.value.r = srgbToLinear(v.color.r);
    props.Color.value.g = srgbToLinear(v.color.g);
    props.Color.value.b = srgbToLinear(v.color.b);
  }
  if (typeof v.iconId === 'number' && props.IconID) props.IconID.value = Math.round(v.iconId);
  if (v.position && props.Location?.value?.properties) {
    const lp = props.Location.value.properties;
    if (lp.X) lp.X.value = v.position.x;
    if (lp.Y) lp.Y.value = v.position.y;
    if (lp.Z) lp.Z.value = v.position.z;
  }
}

function applyDeleteMapMarker(save: SatisfactorySave, edit: SaveEdit): void {
  const { arr, idx } = findMarker(save, edit.target);
  if (!arr || idx === -1) throw new Error(`DeleteMapMarker: marker not found (${edit.target})`);
  arr.splice(idx, 1);
}

// Bump the Project Assembly / Space Elevator phase. target: phase-manager
// instanceName. value: { index }. Sets the current phase and leaves a consistent
// "just entered phase N" state — target = next phase, nothing paid toward it yet —
// so the game's Space-Elevator UI doesn't read a half-paid stale target.
function applySetGamePhase(save: SatisfactorySave, edit: SaveEdit): void {
  const v = edit.value as { index: number };
  if (!v || typeof v.index !== 'number' || !isFinite(v.index)) {
    throw new Error(`SetGamePhase: invalid value for ${edit.target}`);
  }
  const idx = Math.max(0, Math.min(PHASE_COUNT - 1, Math.round(v.index)));
  const mgr = findEntity(save, edit.target);
  const cur = mgr?.properties?.mCurrentGamePhase;
  if (!cur?.value) throw new Error(`SetGamePhase: phase manager not found (${edit.target})`);
  cur.value.levelName = '';
  cur.value.pathName = gamePhasePath(idx);
  const tgt = mgr.properties.mTargetGamePhase;
  if (tgt?.value) {
    tgt.value.levelName = '';
    tgt.value.pathName = gamePhasePath(Math.min(PHASE_COUNT - 1, idx + 1));
  }
  if (Array.isArray(mgr.properties.mTargetGamePhasePaidOffCosts?.values)) {
    mgr.properties.mTargetGamePhasePaidOffCosts.values = [];
  }
}

const MUTATORS: Record<string, (save: SatisfactorySave, edit: SaveEdit) => void> = {
  SetPlayerPosition: applySetPlayerPosition,
  SetInventorySlot: applySetInventorySlot,
  SetPlayerHealth: applySetPlayerHealth,
  SetSchematicPurchased: applySetSchematicPurchased,
  SetDepotItem: applySetDepotItem,
  SetMachineClock: applySetMachineClock,
  SetMapMarker: applySetMapMarker,
  DeleteMapMarker: applyDeleteMapMarker,
  SetGamePhase: applySetGamePhase,
};

export function applyEdits(save: SatisfactorySave, edits: SaveEdit[]): void {
  for (const edit of edits) {
    const mutator = MUTATORS[edit.kind];
    if (!mutator) throw new Error(`Unknown edit kind: ${edit.kind}`);
    mutator(save, edit);
  }
}

// ── Serialization ───────────────────────────────────────────────────────────

/** Serialize a parsed save back to a .sav Buffer (header chunk + body chunks). */
export function serializeSave(save: SatisfactorySave): Buffer {
  const parts: Buffer[] = [];
  Parser.WriteSave(
    save,
    (header) => parts.push(Buffer.from(header)),
    (chunk) => parts.push(Buffer.from(chunk)),
  );
  return Buffer.concat(parts);
}

/** Exact-sized ArrayBuffer for a Buffer (avoids passing a pooled/over-sized backing store). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// ── Persist orchestration ───────────────────────────────────────────────────

export interface PersistOptions {
  saveName: string;
  mode: 'copy' | 'load';
  edits: SaveEdit[];
}

export interface PersistResult {
  saveName: string;
  mode: 'copy' | 'load';
  target: 'api' | 'mount';
  backupPath: string | null; // only set when overwriting the original
}

/**
 * Apply staged edits and persist, without ever mutating the loaded save in place:
 *  1. Parse an isolated working copy from the current save's bytes (also the
 *     overwrite backup), apply edits to it, and serialize that.
 *  2. Upload via the SF API (`UploadSavegame`, optionally loading it live), or —
 *     in mount-only mode with no API — write the .sav into the mount dir.
 *  3. Settle what the viewer shows:
 *       - load (any name): we're now viewing the edited save → switch to it.
 *       - copy + overwrite: the original file now holds the edits → view edited under same name.
 *       - copy + new name: a side-copy that doesn't change what we're viewing → keep the original.
 * Because the loaded save is never mutated, a failed persist leaves state intact.
 */
export async function persistEdits(opts: PersistOptions): Promise<PersistResult> {
  const original = getSave();
  if (!original) throw new Error('No save loaded.');
  const saveName = opts.saveName.trim();
  if (!saveName) throw new Error('Save name is required.');
  if (!opts.edits?.length) throw new Error('No edits to persist.');

  const loadedName = (getSaveStatus().sourceName ?? 'save').replace(/\.sav$/i, '');
  const overwriting = saveName.toLowerCase() === loadedName.toLowerCase();

  // 1) Isolated working copy (round-trip from the current bytes), then edit it.
  const preEditBytes = serializeSave(original);
  const working = Parser.ParseSave(loadedName, toArrayBuffer(preEditBytes));
  applyEdits(working, opts.edits);
  const editedBytes = serializeSave(working);

  // Back up only when overwriting the loaded save — otherwise the untouched
  // original already serves as the backup and a snapshot would just be clutter.
  let backupPath: string | null = null;
  if (overwriting) {
    const backupDir = path.join(__dirname, '../../data/backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, `${loadedName}-${stamp}.pre-edit.sav`);
    fs.writeFileSync(backupPath, preEditBytes);
  }

  // 2) Persist by active mode. Capture the written save's source metadata
  //    (mount mtime / API saveDateTime) so the settle below can hand the
  //    newer-save watcher a valid baseline — see step 3.
  let target: 'api' | 'mount';
  let settledMtimeMs: number | null = null;
  let settledSaveDateTime: string | null = null;
  if (isConnected()) {
    await uploadSavegame(saveName, editedBytes, opts.mode === 'load');
    target = 'api';
    // The save we just uploaded is now the newest in the session, so the
    // session-latest saveDateTime is its timestamp (or that of an autosave that
    // landed in the meantime, which is an even safer baseline — still newer).
    settledSaveDateTime = (await findLatestApiSave())?.saveDateTime ?? null;
  } else if (getSaveSourceMode() === 'mount') {
    const filePath = path.join(config.saveMountPath, `${saveName}.sav`);
    fs.writeFileSync(filePath, editedBytes);
    target = 'mount';
    settledMtimeMs = fs.statSync(filePath).mtimeMs;
  } else {
    throw new Error('No persist target: connect to the server to upload, or mount a save directory.');
  }

  // 3) Settle the viewed save. A plain new-name copy doesn't change what we're
  //    viewing (keep the original); loading or overwriting does. Carry the source
  //    metadata through: without it setSave resets sourceMtimeMs/sourceSaveDateTime
  //    to null, which makes the newer-save watcher's comparison gate (loaded != null
  //    && found > loaded) fail closed — detection then goes silent until the next
  //    full reload re-establishes a baseline.
  if (opts.mode === 'load' || overwriting) {
    setSave(working, saveName, settledMtimeMs, settledSaveDateTime);
  }

  return { saveName, mode: opts.mode, target, backupPath };
}
