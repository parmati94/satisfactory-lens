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
import { mapTilesRouter } from './routes/mapTiles';
import { autoLoadSaveIfNeeded } from './save/autoLoad';

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
app.use(mapTilesRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Auto-connect to SF server if SF_HOST is pre-configured via env
if (config.sfHost) {
  autoConnect()
    .then(async () => {
      console.log(`[sf] Connected to ${config.sfHost}:${config.sfPort}`);
      // Covers the no-mount case: nothing to load at listen-time below since the
      // connection hadn't resolved yet, so this is our first chance to auto-load via the API.
      await autoLoadSaveIfNeeded();
    })
    .catch((err: Error) => console.error('[sf] Auto-connect failed:', err.message));
}

app.listen(config.port, '127.0.0.1', async () => {
  console.log(`Satisfactory Lens backend listening on port ${config.port}`);
  // Auto-load from the mount if present; otherwise via the API if already connected.
  await autoLoadSaveIfNeeded();
});
