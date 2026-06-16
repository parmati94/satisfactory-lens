import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { config } from '../config';
import { setSave, setSaveError, setSaveLoading } from './saveState';
import { downloadSavegame } from '../api/sfClient';

/** Find the most recently modified .sav file in the mount directory, with its mtime. */
export function findMountedSaveWithMtime(): { file: string; mtimeMs: number } | null {
  const dir = config.saveMountPath;
  if (!fs.existsSync(dir)) return null;

  // If a specific file is configured, use it
  if (config.saveFileName) {
    const specific = path.join(dir, config.saveFileName);
    if (!fs.existsSync(specific)) return null;
    return { file: specific, mtimeMs: fs.statSync(specific).mtimeMs };
  }

  // Otherwise pick the newest .sav file in the directory
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.sav')) continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { file: full, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
}

/** Find the most recently modified .sav file in the mount directory. */
export function findMountedSave(): string | null {
  return findMountedSaveWithMtime()?.file ?? null;
}

/** Parse a save file from a Buffer and store in state. */
function parseAndStore(buf: Buffer, name: string, mtimeMs: number | null = null): void {
  console.log(`[save] Parsing "${name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
  const save = Parser.ParseSave(name, buf.buffer as ArrayBuffer);
  setSave(save, name, mtimeMs);
  console.log(`[save] Parsed "${name}" successfully.`);
}

/** Load the save from the mounted disk path. */
export async function loadFromDisk(): Promise<void> {
  const found = findMountedSaveWithMtime();
  if (!found) {
    setSaveError(`No .sav file found in "${config.saveMountPath}"`);
    return;
  }
  setSaveLoading(true);
  try {
    const buf = fs.readFileSync(found.file);
    parseAndStore(buf, path.basename(found.file), found.mtimeMs);
  } catch (err) {
    setSaveError(`Failed to load "${found.file}": ${(err as Error).message}`);
  }
}

/** Download a save from the Satisfactory HTTP API and parse it. */
export async function loadFromApi(saveName: string): Promise<void> {
  setSaveLoading(true);
  try {
    console.log(`[save] Downloading "${saveName}" from server…`);
    const buf = await downloadSavegame(saveName);
    parseAndStore(buf, saveName);
  } catch (err) {
    setSaveError(`Failed to download "${saveName}": ${(err as Error).message}`);
  }
}
