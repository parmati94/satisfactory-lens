import { config } from '../config';
import { childLogger } from '../log';
import { loadLatest, getSaveSourceMode } from './loader';
import { getSaveStatus } from './saveState';
import { broadcastSaveReloaded, startWatching } from './watcher';

const log = childLogger('save');

/**
 * Load the active save source if nothing is loaded yet, and (re)start the newer-save
 * monitor to match. Idempotent and safe to call from multiple trigger points — backend
 * startup, SF auto-connect (env), and a manual Connect via the UI — without risk of a
 * redundant reload once something is already loaded.
 */
export async function autoLoadSaveIfNeeded(): Promise<void> {
  if (getSaveStatus().loaded) return;

  const mode = getSaveSourceMode();
  if (mode === 'none') return;

  await loadLatest();
  const status = getSaveStatus();
  if (status.loaded) {
    log.info(`Auto-loaded "${status.sourceName}" via ${mode}`);
    broadcastSaveReloaded({ sourceName: status.sourceName });
    if (config.enableAutoWatch) startWatching();
  } else {
    log.warn(`Auto-load failed: ${status.error}`);
  }
}
