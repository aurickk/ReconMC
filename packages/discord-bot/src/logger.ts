/**
 * Simple structured logger. Set LOG_LEVEL=debug|info|warn|error (default: info).
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const current = LEVELS[(process.env.LOG_LEVEL as keyof typeof LEVELS) ?? 'info'] ?? 1;

function log(level: keyof typeof LEVELS, ...args: unknown[]) {
  if (LEVELS[level] < current) return;
  const prefix = `[${level.toUpperCase()}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.info(prefix, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};
