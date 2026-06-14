import fs from 'fs';
import { Response } from 'express';
import { findMountedSave, loadFromDisk } from './loader';

// SSE clients waiting for save reload events
const sseClients = new Set<Response>();

let watcher: fs.FSWatcher | null = null;
let watchedPath: string | null = null;
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

/** Start watching the mounted save file for changes. Re-parses on each write. */
export function startWatching(): void {
  stopWatching();

  const filePath = findMountedSave();
  if (!filePath) {
    console.log('[save-watch] No save file found to watch.');
    return;
  }

  console.log(`[save-watch] Watching "${filePath}"…`);
  watchedPath = filePath;

  watcher = fs.watch(filePath, (event) => {
    if (event !== 'change') return;
    // Debounce: game writes the file multiple times during a save
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log(`[save-watch] Change detected, reloading…`);
      await loadFromDisk();
      broadcastSaveReloaded({ sourceName: filePath });
    }, 2000);
  });

  watcher.on('error', (err) => {
    console.error('[save-watch] Watcher error:', err.message);
  });
}

export function stopWatching(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
  watchedPath = null;
}

export function getWatchedPath(): string | null {
  return watchedPath;
}
