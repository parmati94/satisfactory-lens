import { pino } from 'pino';
import { config } from './config';

// Central application logger. Verbosity is controlled by LOG_LEVEL; output is
// newline-delimited JSON by default (greppable / ship-able from Docker logs) and
// switches to colorized human-readable lines when LOG_PRETTY=true (use in dev).
//
// Subsystems take a child via `childLogger('name')`, which tags every line with
// `mod: 'name'` — the structured replacement for the old `[tag]` string prefixes,
// so you can filter by subsystem. The heaviest output (full Satisfactory API
// request/response bodies) sits at `trace`, off unless LOG_LEVEL=trace.
export const logger = pino({
  level: config.logLevel,
  // Drop pid/hostname noise; subsystem context comes from the `mod` child field.
  base: undefined,
  ...(config.logPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            // Fold the subsystem into a `[mod]` prefix instead of its own line. Other
            // structured fields (HTTP req/res at debug, SF API bodies at trace) keep
            // their expanded multi-line form — simple string logs stay one line, rich
            // logs stay readable.
            messageFormat: '{if mod}[{mod}] {end}{msg}',
            ignore: 'pid,hostname,mod',
          },
        },
      }
    : {}),
});

export function childLogger(mod: string) {
  return logger.child({ mod });
}
