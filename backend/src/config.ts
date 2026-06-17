import dotenv from 'dotenv';
dotenv.config();

// The placeholder shipped in the example compose files. Booting with this value
// while login is enabled means tokens are forgeable — guarded against in index.ts.
export const DEFAULT_SESSION_SECRET = 'change-me-in-production';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),

  // App-level auth
  enableLogin: (process.env.ENABLE_LOGIN ?? 'false').toLowerCase() === 'true',
  username: process.env.USERNAME ?? 'admin',
  password: process.env.PASSWORD ?? 'admin',
  sessionSecret: process.env.SESSION_SECRET ?? DEFAULT_SESSION_SECRET,

  // Satisfactory dedicated server
  sfHost: process.env.SF_HOST ?? '',
  sfPort: parseInt(process.env.SF_PORT ?? '7777', 10),
  sfPassword: process.env.SF_PASSWORD ?? '',
  sfAllowSelfSigned: (process.env.SF_ALLOW_SELF_SIGNED ?? 'true').toLowerCase() !== 'false',

  // Save file (Phase 2). Fixed mount point inside the container — point a docker-compose
  // volume at it if you want local-disk access; not env-configurable, nothing to set here.
  saveMountPath: '/app/saves',
  enableAutoWatch: (process.env.ENABLE_AUTO_WATCH ?? 'true').toLowerCase() === 'true',
  // How often (seconds) to poll the SF API for a newer save when no mount is present
  savePollIntervalSeconds: parseInt(process.env.SAVE_POLL_INTERVAL_SECONDS ?? '30', 10),
} as const;
