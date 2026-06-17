import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { getSave, getSaveStatus, setSave } from './saveState';
import { findSchematicManager } from './extractors/schematics';
import { getSaveSourceMode } from './loader';
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

const MUTATORS: Record<string, (save: SatisfactorySave, edit: SaveEdit) => void> = {
  SetPlayerPosition: applySetPlayerPosition,
  SetInventorySlot: applySetInventorySlot,
  SetPlayerHealth: applySetPlayerHealth,
  SetSchematicPurchased: applySetSchematicPurchased,
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

  // 2) Persist by active mode.
  let target: 'api' | 'mount';
  if (isConnected()) {
    await uploadSavegame(saveName, editedBytes, opts.mode === 'load');
    target = 'api';
  } else if (getSaveSourceMode() === 'mount') {
    fs.writeFileSync(path.join(config.saveMountPath, `${saveName}.sav`), editedBytes);
    target = 'mount';
  } else {
    throw new Error('No persist target: connect to the server to upload, or mount a save directory.');
  }

  // 3) Settle the viewed save. A plain new-name copy doesn't change what we're
  //    viewing (keep the original); loading or overwriting does.
  if (opts.mode === 'load' || overwriting) {
    setSave(working, saveName);
  }

  return { saveName, mode: opts.mode, target, backupPath };
}
