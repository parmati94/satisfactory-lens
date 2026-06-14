import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { config } from '../config';
import { setSave, setSaveError, setSaveLoading } from './saveState';
import { downloadSavegame } from '../api/sfClient';

/** Find the most recently modified .sav file in the mount directory. */
export function findMountedSave(): string | null {
  const dir = config.saveMountPath;
  if (!fs.existsSync(dir)) return null;

  // If a specific file is configured, use it
  if (config.saveFileName) {
    const specific = path.join(dir, config.saveFileName);
    return fs.existsSync(specific) ? specific : null;
  }

  // Otherwise pick the newest .sav file in the directory
  let newest: { file: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.sav')) continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (!newest || stat.mtimeMs > newest.mtime) {
      newest = { file: full, mtime: stat.mtimeMs };
    }
  }
  return newest?.file ?? null;
}

/** Parse a save file from a Buffer and store in state. */
function parseAndStore(buf: Buffer, name: string): void {
  console.log(`[save] Parsing "${name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
  const save = Parser.ParseSave(name, buf.buffer as ArrayBuffer);
  setSave(save, name);
  console.log(`[save] Parsed "${name}" successfully.`);
}

/** Load the save from the mounted disk path. */
export async function loadFromDisk(): Promise<void> {
  const filePath = findMountedSave();
  if (!filePath) {
    setSaveError(`No .sav file found in "${config.saveMountPath}"`);
    return;
  }
  setSaveLoading(true);
  try {
    const buf = fs.readFileSync(filePath);
    parseAndStore(buf, path.basename(filePath));
  } catch (err) {
    setSaveError(`Failed to load "${filePath}": ${(err as Error).message}`);
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
