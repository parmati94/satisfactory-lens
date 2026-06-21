import fs from 'fs';
import path from 'path';
import { Response } from 'express';
import { config } from '../config';
import { findMountedSaveWithMtime, findLatestApiSave, getSaveSourceMode } from './loader';
import { getLoadedSourceMtimeMs, getLoadedSourceSaveDateTime } from './saveState';
import { childLogger } from '../log';

const log = childLogger('save-watch');

// SSE clients waiting for save events
const sseClients = new Set<Response>();

let fsWatcher: fs.FSWatcher | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let watchedDir: string | null = null;

// Last broadcast newer-save state, so repeated checks (every poll tick, or every fs event
// while a save sits unloaded) don't re-log/re-broadcast identical info over and over.
let lastBroadcastInfo: { newerSaveAvailable: boolean; newerSaveName: string | null } | null = null;

export function addSseClient(res: Response): void {
  sseClients.add(res);
}

export function removeSseClient(res: Response): void {
  sseClients.delete(res);
}

export function broadcastSaveReloaded(status: { sourceName: string | null }): void {
  const payload = JSON.stringify({ event: 'save_reloaded', ...status });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

export function broadcastSaveError(message: string): void {
  const payload = JSON.stringify({ event: 'save_error', message });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

function broadcastSaveAvailable(info: Awaited<ReturnType<typeof checkForNewerSave>>): void {
  const payload = JSON.stringify({ event: 'save_available', ...info });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

/** Check for a newer save and broadcast/log only if the result actually changed since
 *  the last check — avoids re-announcing the same "newer save available" on every poll
 *  tick or fs event while the user just hasn't reloaded yet. */
async function notifyIfChanged(): Promise<void> {
  const info = await checkForNewerSave();
  if (
    lastBroadcastInfo &&
    lastBroadcastInfo.newerSaveAvailable === info.newerSaveAvailable &&
    lastBroadcastInfo.newerSaveName === info.newerSaveName
  ) {
    return;
  }
  lastBroadcastInfo = info;
  if (info.newerSaveAvailable) {
    log.info(`Newer save detected: "${info.newerSaveName}"`);
  }
  broadcastSaveAvailable(info);
}

async function checkDiskForNewerSave(): Promise<{ newerSaveAvailable: boolean; newerSaveName: string | null }> {
  const found = findMountedSaveWithMtime();
  if (!found) return { newerSaveAvailable: false, newerSaveName: null };

  // If the loaded save has no on-disk mtime (e.g. downloaded via the SF API rather than
  // read from the mount), there's nothing comparable to flag as "newer" — skip rather
  // than false-positive against whatever happens to be sitting in the mount dir.
  const loadedMtimeMs = getLoadedSourceMtimeMs();
  const newerSaveAvailable = loadedMtimeMs !== null && found.mtimeMs > loadedMtimeMs;
  return { newerSaveAvailable, newerSaveName: path.basename(found.file) };
}

async function checkApiForNewerSave(): Promise<{ newerSaveAvailable: boolean; newerSaveName: string | null }> {
  const found = await findLatestApiSave();
  if (!found) return { newerSaveAvailable: false, newerSaveName: null };

  // Same rationale as disk mode: nothing to compare against if the loaded save didn't
  // come from a previous API-resolved saveDateTime (e.g. loaded via disk, or a manual
  // by-name download via the modal).
  const loadedSaveDateTime = getLoadedSourceSaveDateTime();
  const newerSaveAvailable = loadedSaveDateTime !== null && found.saveDateTime > loadedSaveDateTime;
  return { newerSaveAvailable, newerSaveName: found.saveName };
}

/**
 * Compare the latest known save — on disk or via the API, whichever mode is currently
 * active — against the currently loaded one. Read-only — never reloads.
 */
export async function checkForNewerSave(): Promise<{ newerSaveAvailable: boolean; newerSaveName: string | null }> {
  const none = { newerSaveAvailable: false, newerSaveName: null };
  // Best-effort, read-only poll. It's awaited inside fullStatus() (so it rides on most
  // status responses) and runs on a timer — a transient SF API hiccup (e.g. the socket
  // closing mid-fetch: UND_ERR_SOCKET) MUST degrade to "no newer save", never reject.
  // An unhandled rejection here would otherwise take the whole process down.
  try {
    const mode = getSaveSourceMode();
    if (mode === 'mount') return await checkDiskForNewerSave();
    if (mode === 'api') return await checkApiForNewerSave();
    return none;
  } catch (err) {
    log.warn(`newer-save check failed (ignored): ${(err as Error).message}`);
    return none;
  }
}

/**
 * Watch for newer saves becoming available. Mount mode watches the save directory itself
 * (saves rotate across multiple autosave filenames, so we watch the directory, not a
 * single file). API mode has no filesystem to watch, so it polls `EnumerateSessions`
 * instead — that's metadata-only (no save bytes), so polling is cheap. Either way we only
 * *notify*; we never reload automatically, since that could clobber in-progress edits.
 */
export function startWatching(): void {
  stopWatching();

  const mode = getSaveSourceMode();

  if (mode === 'mount') {
    const dir = config.saveMountPath;
    if (!fs.existsSync(dir)) {
      log.warn(`Save directory "${dir}" does not exist; not watching.`);
      return;
    }

    log.info(`Watching directory "${dir}" for newer saves…`);
    watchedDir = dir;

    fsWatcher = fs.watch(dir, () => {
      // Debounce: the game can write/rename several files in quick succession during a save
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyIfChanged, 2000);
    });

    fsWatcher.on('error', (err) => {
      log.error(`Watcher error: ${err.message}`);
    });
    return;
  }

  if (mode === 'api') {
    const intervalMs = config.savePollIntervalSeconds * 1000;
    log.info(`Polling the Satisfactory API every ${config.savePollIntervalSeconds}s for newer saves…`);

    const tick = async () => {
      try {
        await notifyIfChanged();
      } catch (err) {
        log.error(`Poll error: ${(err as Error).message}`);
      }
    };

    tick(); // check immediately rather than waiting a full interval
    pollTimer = setInterval(tick, intervalMs);
    return;
  }

  log.info('No save source available (no mount, not connected); not watching.');
}

export function stopWatching(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (fsWatcher) { fsWatcher.close(); fsWatcher = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  watchedDir = null;
  lastBroadcastInfo = null;
}

/** The mount directory being watched, if mount mode is active. Null in API/none mode. */
export function getWatchedPath(): string | null {
  return watchedDir;
}
