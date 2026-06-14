import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { requireAuth } from './auth';
import { appAuthRouter } from './routes/appAuth';
import { sfConnectRouter } from './routes/sfConnect';
import { serverStateRouter } from './routes/serverState';
import { savesRouter } from './routes/saves';
import { settingsRouter } from './routes/settings';
import { autoConnect } from './api/sfClient';
import { saveViewerRouter } from './routes/saveViewer';
import { loadFromDisk } from './save/loader';
import { startWatching, broadcastSaveReloaded } from './save/watcher';
import { getSaveStatus } from './save/saveState';
import { findMountedSave } from './save/loader';

const app = express();

app.use(express.json());
app.use(cookieParser());

// App auth routes — no requireAuth guard (login/logout/status must be public)
app.use(appAuthRouter);

// All other /api/* routes require app auth
app.use('/api', requireAuth);
app.use(sfConnectRouter);
app.use(serverStateRouter);
app.use(savesRouter);
app.use(settingsRouter);
app.use(saveViewerRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Auto-connect to SF server if SF_HOST is pre-configured via env
if (config.sfHost) {
  autoConnect()
    .then(() => console.log(`[sf] Connected to ${config.sfHost}:${config.sfPort}`))
    .catch((err: Error) => console.error('[sf] Auto-connect failed:', err.message));
}

app.listen(config.port, '127.0.0.1', async () => {
  console.log(`Satisfactory Lens backend listening on port ${config.port}`);

  // Auto-load save from mounted path on startup
  if (findMountedSave()) {
    await loadFromDisk();
    const status = getSaveStatus();
    if (status.loaded) {
      console.log(`[save] Auto-loaded "${status.sourceName}"`);
      if (config.enableAutoWatch) {
        startWatching();
      }
    } else {
      console.warn(`[save] Auto-load failed: ${status.error}`);
    }
  }
});
