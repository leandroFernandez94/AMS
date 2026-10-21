/**
 * Structured logger for the Write API.
 *
 * Emits one JSON object per line to stdout so logs are trivially greppable
 * and consumable by log aggregators (Dozzle, Loki, etc.). Kept dependency-free
 * on purpose; AMS does not need a full logging framework yet.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Creates a logger that writes JSON lines to a writable stream (stdout by
 * default). `minLevel` filters entries below the threshold.
 */
export function createLogger(
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  minLevel: LogLevel = "info",
): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const entry: LogEntry = { level, msg, ts: new Date().toISOString(), ...(fields ?? {}) };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
