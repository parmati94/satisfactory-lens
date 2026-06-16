import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { getSave, getSaveStatus } from './saveState';
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

const MUTATORS: Record<string, (save: SatisfactorySave, edit: SaveEdit) => void> = {
  SetPlayerPosition: applySetPlayerPosition,
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
 * Apply staged edits to the in-memory save and persist:
 *  1. If overwriting the original name, back it up first; for a new-name copy the
 *     original file is itself the backup, so we skip the (redundant) snapshot.
 *  2. Apply edits (idempotent set-value ops).
 *  3. Serialize the edited save.
 *  4. Upload via the SF API (`UploadSavegame`, optionally loading it live), or — in
 *     mount-only mode with no API — write the .sav into the mount dir.
 * On failure the caller should reload from source to discard the partial in-memory
 * mutation (edits are idempotent, so a retry is also safe).
 */
export async function persistEdits(opts: PersistOptions): Promise<PersistResult> {
  const save = getSave();
  if (!save) throw new Error('No save loaded.');
  const saveName = opts.saveName.trim();
  if (!saveName) throw new Error('Save name is required.');
  if (!opts.edits?.length) throw new Error('No edits to persist.');

  // 1) Back up only when overwriting the loaded save — otherwise the untouched
  //    original already serves as the backup and a snapshot would just be clutter.
  const loadedName = (getSaveStatus().sourceName ?? 'save').replace(/\.sav$/i, '');
  const overwriting = saveName.toLowerCase() === loadedName.toLowerCase();
  let backupPath: string | null = null;
  if (overwriting) {
    const backupDir = path.join(__dirname, '../../data/backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, `${loadedName}-${stamp}.pre-edit.sav`);
    fs.writeFileSync(backupPath, serializeSave(save));
  }

  // 2) Apply + 3) serialize.
  applyEdits(save, opts.edits);
  const buffer = serializeSave(save);

  // 4) Persist by active mode.
  if (isConnected()) {
    await uploadSavegame(saveName, buffer, opts.mode === 'load');
    return { saveName, mode: opts.mode, target: 'api', backupPath };
  }
  if (getSaveSourceMode() === 'mount') {
    fs.writeFileSync(path.join(config.saveMountPath, `${saveName}.sav`), buffer);
    return { saveName, mode: opts.mode, target: 'mount', backupPath };
  }
  throw new Error('No persist target: connect to the server to upload, or mount a save directory.');
}
