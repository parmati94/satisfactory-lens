import fs from 'fs';
import path from 'path';
import { Response } from 'express';
import { config } from '../config';
import { findMountedSaveWithMtime } from './loader';
import { getLoadedSourceMtimeMs } from './saveState';

// SSE clients waiting for save events
const sseClients = new Set<Response>();

let watcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

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

function broadcastSaveAvailable(info: ReturnType<typeof checkForNewerSave>): void {
  const payload = JSON.stringify({ event: 'save_available', ...info });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

/** Compare the newest file on disk against the currently loaded save. Read-only — never reloads. */
export function checkForNewerSave(): {
  newerSaveAvailable: boolean;
  newerSaveName: string | null;
  newerSaveMtimeMs: number | null;
} {
  const found = findMountedSaveWithMtime();
  if (!found) return { newerSaveAvailable: false, newerSaveName: null, newerSaveMtimeMs: null };

  // If the loaded save has no on-disk mtime (e.g. downloaded via the SF API rather than
  // read from the mount), there's nothing comparable to flag as "newer" — skip rather
  // than false-positive against whatever happens to be sitting in the mount dir.
  const loadedMtimeMs = getLoadedSourceMtimeMs();
  const newerSaveAvailable = loadedMtimeMs !== null && found.mtimeMs > loadedMtimeMs;
  return {
    newerSaveAvailable,
    newerSaveName: path.basename(found.file),
    newerSaveMtimeMs: found.mtimeMs,
  };
}

/**
 * Watch the save mount directory for changes. Saves rotate across multiple autosave
 * filenames, so we watch the directory (not a single file) and only *notify* clients
 * that a newer save is available — we never reload automatically, since that could
 * clobber in-progress edits.
 */
export function startWatching(): void {
  stopWatching();

  const dir = config.saveMountPath;
  if (!fs.existsSync(dir)) {
    console.log(`[save-watch] Save directory "${dir}" does not exist; not watching.`);
    return;
  }

  console.log(`[save-watch] Watching directory "${dir}" for newer saves…`);
  watchedDir = dir;

  watcher = fs.watch(dir, () => {
    // Debounce: the game can write/rename several files in quick succession during a save
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const info = checkForNewerSave();
      if (info.newerSaveAvailable) {
        console.log(`[save-watch] Newer save detected: "${info.newerSaveName}"`);
      }
      broadcastSaveAvailable(info);
    }, 2000);
  });

  watcher.on('error', (err) => {
    console.error('[save-watch] Watcher error:', err.message);
  });
}

export function stopWatching(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
  watchedDir = null;
}

export function getWatchedPath(): string | null {
  return watchedDir;
}
