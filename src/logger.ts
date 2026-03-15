/** Simple leveled logger prefixed with [cycles-budget-guard]. */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const PREFIX = "[cycles-budget-guard]";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(minLevel: string): Logger {
  const threshold = LEVELS[(minLevel as Level)] ?? LEVELS.info;

  function shouldLog(level: Level): boolean {
    return LEVELS[level] >= threshold;
  }

  return {
    debug(msg, ...args) {
      if (shouldLog("debug")) console.debug(PREFIX, msg, ...args);
    },
    info(msg, ...args) {
      if (shouldLog("info")) console.info(PREFIX, msg, ...args);
    },
    warn(msg, ...args) {
      if (shouldLog("warn")) console.warn(PREFIX, msg, ...args);
    },
    error(msg, ...args) {
      if (shouldLog("error")) console.error(PREFIX, msg, ...args);
    },
  };
}
