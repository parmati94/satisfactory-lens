import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),

  // App-level auth
  enableLogin: (process.env.ENABLE_LOGIN ?? 'false').toLowerCase() === 'true',
  username: process.env.USERNAME ?? 'admin',
  password: process.env.PASSWORD ?? 'admin',
  sessionSecret: process.env.SESSION_SECRET ?? 'change-me-in-production',

  // Satisfactory dedicated server
  sfHost: process.env.SF_HOST ?? '',
  sfPort: parseInt(process.env.SF_PORT ?? '7777', 10),
  sfPassword: process.env.SF_PASSWORD ?? '',
  sfAllowSelfSigned: (process.env.SF_ALLOW_SELF_SIGNED ?? 'true').toLowerCase() !== 'false',

  // Save file (Phase 2)
  saveMountPath: process.env.SAVE_MOUNT_PATH ?? '/app/saves',
  saveFileName: process.env.SAVE_FILE_NAME ?? '',  // specific .sav filename; blank = auto-select newest
  enableAutoWatch: (process.env.ENABLE_AUTO_WATCH ?? 'true').toLowerCase() === 'true',
} as const;
