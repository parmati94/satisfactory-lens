import express from 'express';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { config, DEFAULT_SESSION_SECRET } from './config';
import { logger, childLogger } from './log';
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

// Fail fast on an unsafe auth config: login enabled but the session secret is
// still unset/the shipped placeholder means JWTs are forgeable. Only fires when
// ENABLE_LOGIN=true, so default local/dev runs (login off) are unaffected.
if (config.enableLogin && (!config.sessionSecret || config.sessionSecret === DEFAULT_SESSION_SECRET)) {
  childLogger('auth').fatal(
    'ENABLE_LOGIN=true but SESSION_SECRET is unset or the default placeholder. ' +
    'Session tokens would be forgeable. Set a strong, random secret ' +
    '(SESSION_SECRET=$(openssl rand -hex 32)). Refusing to start.',
  );
  process.exit(1);
}

const app = express();

// Behind a reverse proxy (nginx/Caddy/Cloudflare) — honour X-Forwarded-* so
// req.ip (login rate limiting) reflects the real client. Harmless for local/dev.
app.set('trust proxy', 1);

// HTTP access logging. Successful GETs (mostly UI polling) log at debug to keep
// the default `info` stream quiet; mutations log at info, client errors at warn,
// failures at error. Auth header/cookie are redacted; req/res are trimmed to the
// essentials. Health probe is excluded entirely.
app.use(pinoHttp({
  logger: childLogger('http'),
  autoLogging: { ignore: (req) => req.url === '/api/health' },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return _req.method === 'GET' ? 'debug' : 'info';
  },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

app.use(express.json());
app.use(cookieParser());

// Health check stays public (used by Docker/edge probes) — registered before the
// /api auth guard so it never 401s when login is enabled.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

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

// Auto-connect to SF server if SF_HOST is pre-configured via env
const sfLog = childLogger('sf');
if (config.sfHost) {
  autoConnect()
    .then(async () => {
      sfLog.info(`Connected to ${config.sfHost}:${config.sfPort}`);
      // Covers the no-mount case: nothing to load at listen-time below since the
      // connection hadn't resolved yet, so this is our first chance to auto-load via the API.
      await autoLoadSaveIfNeeded();
    })
    .catch((err: Error) => sfLog.error(`Auto-connect failed: ${err.message}`));
}

app.listen(config.port, '127.0.0.1', async () => {
  logger.info(`Satisfactory Lens backend listening on port ${config.port}`);
  // Auto-load from the mount if present; otherwise via the API if already connected.
  await autoLoadSaveIfNeeded();
});
