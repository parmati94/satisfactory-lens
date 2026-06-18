import fs from 'fs';
import path from 'path';
import { Parser } from '@etothepii/satisfactory-file-parser';
import { config } from '../config';
import { setSave, setSaveError, setSaveLoading } from './saveState';
import { downloadSavegame, enumerateSessions, queryServerState, isConnected } from '../api/sfClient';
import { childLogger } from '../log';

const log = childLogger('save');

export type SaveSourceMode = 'mount' | 'api' | 'none';

interface SfSaveHeader {
  saveName: string;
  saveDateTime: string;
  [key: string]: unknown;
}

interface SfSession {
  sessionName: string;
  saveHeaders?: SfSaveHeader[];
  [key: string]: unknown;
}

/** Find the most recently modified .sav file in the mount directory, with its mtime. */
export function findMountedSaveWithMtime(): { file: string; mtimeMs: number } | null {
  const dir = config.saveMountPath;
  if (!fs.existsSync(dir)) return null;

  // Pick the newest .sav file in the directory — which specific save to load is a UI
  // concern (Saves tab / Download modal), not something to pin via config.
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

/**
 * Which save source is currently active. A mounted save file takes precedence when
 * present; otherwise we fall back to the Satisfactory HTTP API if connected. Computed
 * fresh each call rather than cached, since either condition can change at runtime
 * (SF connects/disconnects via the UI).
 */
export function getSaveSourceMode(): SaveSourceMode {
  if (findMountedSave()) return 'mount';
  if (isConnected()) return 'api';
  return 'none';
}

/** Resolve the newest save in the server's currently active session via the SF API. */
export async function findLatestApiSave(): Promise<
  { sessionName: string; saveName: string; saveDateTime: string } | null
> {
  const [state, result] = await Promise.all([
    queryServerState() as Promise<{ serverGameState?: { activeSessionName?: string } }>,
    enumerateSessions() as Promise<{ sessions: SfSession[] }>,
  ]);

  const activeSessionName = state?.serverGameState?.activeSessionName;
  if (!activeSessionName) return null;

  const session = result?.sessions?.find(
    (s) => s.sessionName?.toLowerCase() === activeSessionName.toLowerCase(),
  );
  const headers = session?.saveHeaders ?? [];
  if (!session || headers.length === 0) return null;

  // saveDateTime is "YYYY.MM.DD-HH.MM.SS" — lexicographically sortable
  const newest = headers.reduce((a, b) => (b.saveDateTime > a.saveDateTime ? b : a));
  return { sessionName: session.sessionName, saveName: newest.saveName, saveDateTime: newest.saveDateTime };
}

/** Parse a save file from a Buffer and store in state. */
function parseAndStore(
  buf: Buffer,
  name: string,
  sourceMtimeMs: number | null = null,
  sourceSaveDateTime: string | null = null,
): void {
  log.info(`Parsing "${name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
  const save = Parser.ParseSave(name, buf.buffer as ArrayBuffer);
  setSave(save, name, sourceMtimeMs, sourceSaveDateTime);
  log.info(`Parsed "${name}" successfully.`);
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

/** Download a specific save by name from the Satisfactory HTTP API and parse it. Stays
 *  fully in-memory — the parser takes the downloaded buffer directly, nothing is written
 *  to disk, so there's no local cache to ever conflict with a mount added later.
 *  `saveDateTime` is optional (the caller already has it from EnumerateSessions, e.g. the
 *  "Load a Different Save" modal) — passing it keeps newer-save polling working afterward;
 *  omitting it just means that comparison is skipped until the next full reload. */
export async function loadFromApi(saveName: string, saveDateTime: string | null = null): Promise<void> {
  setSaveLoading(true);
  try {
    log.info(`Downloading "${saveName}" from server…`);
    const buf = await downloadSavegame(saveName);
    parseAndStore(buf, saveName, null, saveDateTime);
  } catch (err) {
    setSaveError(`Failed to download "${saveName}": ${(err as Error).message}`);
  }
}

/** Resolve and download the newest save in the server's active session via the SF API. */
export async function loadLatestFromApi(): Promise<void> {
  setSaveLoading(true);
  try {
    const found = await findLatestApiSave();
    if (!found) {
      setSaveError('No save found via the Satisfactory API (no active session, or it has no saves yet).');
      return;
    }
    log.info(`Downloading "${found.saveName}" (active session "${found.sessionName}") from server…`);
    const buf = await downloadSavegame(found.saveName);
    parseAndStore(buf, found.saveName, null, found.saveDateTime);
  } catch (err) {
    setSaveError(`Failed to download latest save: ${(err as Error).message}`);
  }
}

/**
 * Load using whichever source is currently active: the mount if a save file is present
 * there, otherwise the Satisfactory API if connected. This is what startup, manual
 * reload, and post-connect auto-load all funnel through.
 */
export async function loadLatest(): Promise<void> {
  const mode = getSaveSourceMode();
  if (mode === 'mount') {
    await loadFromDisk();
  } else if (mode === 'api') {
    await loadLatestFromApi();
  } else {
    setSaveError('No save source available — mount a save directory or connect to the server.');
  }
}
