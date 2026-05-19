type Level = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: Level = 'info';

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function log(level: Level, args: unknown[]): void {
  if (order[level] < order[currentLevel]) return;
  const prefix = `[HereBeDragons]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  debug: (...args: unknown[]): void => log('debug', args),
  info: (...args: unknown[]): void => log('info', args),
  warn: (...args: unknown[]): void => log('warn', args),
  error: (...args: unknown[]): void => log('error', args)
};
