/**
 * Minimal structured logger. Writes JSON lines to stderr so it never collides
 * with the stdio MCP transport (which owns stdout).
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVEL_ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = LEVEL_ORDER[level];
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
