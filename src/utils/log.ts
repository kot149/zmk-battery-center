import * as transport from "@tauri-apps/plugin-log";

export type LogLevel = "warn" | "info" | "debug";
type Level = LogLevel | "error" | "trace";
const ranks: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
let level: LogLevel = import.meta.env.DEV ? "debug" : "warn";
const original = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export function setFrontendLogLevel(next: LogLevel) {
  level = next;
}

export function formatLogArgs(args: unknown[]): string {
  const seen = new WeakSet<object>();
  let budget = 16 * 1024;
  let result = "";
  let truncated = false;
  const append = (text: string) => {
    if (!budget) {
      truncated = true;
      return;
    }
    const bounded = text.slice(0, budget);
    const bytes = new TextEncoder().encode(bounded);
    const size = Math.min(bytes.length, budget);
    let end = size;
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    result += new TextDecoder().decode(bytes.subarray(0, end));
    budget -= end;
    if (bounded.length < text.length || end < bytes.length) {
      budget = 0;
      truncated = true;
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (!budget) {
      truncated = true;
      return;
    }
    if (depth > 8) {
      append("[depth limit]");
      return;
    }
    try {
      if (value === null || typeof value !== "object") {
        append(String(value));
        return;
      }
      if (seen.has(value)) {
        append("[circular]");
        return;
      }
      seen.add(value);
      if (value instanceof Error) {
        append(`${value.name}: `);
        append(value.message);
        append("\n");
        append(value.stack ?? "");
        if ("cause" in value) {
          append("\nCaused by: ");
          visit(value.cause, depth + 1);
        }
      } else {
        append(Array.isArray(value) ? "[" : "{");
        for (const key in value) {
          if (!budget) {
            truncated = true;
            break;
          }
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          append(key);
          append(": ");
          try {
            visit((value as Record<string, unknown>)[key], depth + 1);
          } catch {
            append("[unreadable]");
          }
          append(", ");
        }
        append(Array.isArray(value) ? "]" : "}");
      }
    } catch {
      append("[unreadable]");
    }
  };
  for (const value of args) {
    visit(value, 0);
    append(" ");
    if (!budget) break;
  }
  if (truncated) {
    const bytes = new TextEncoder().encode(result);
    let end = Math.min(bytes.length, 16 * 1024 - 16);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return new TextDecoder().decode(bytes.subarray(0, end)) + " [truncated]";
  }
  return result.trimEnd();
}

export class Logger {
  isEnabled = (requested: Level) => ranks[requested] <= ranks[level];
  private async send(requested: Level, args: unknown[]): Promise<void> {
    if (!this.isEnabled(requested)) return;
    try {
      const values = args.map((arg) => (typeof arg === "function" ? arg() : arg));
      await transport[requested](formatLogArgs(values));
    } catch (error) {
      original.error("Failed to write application log", error);
    }
  }
  warn = (...args: unknown[]) => this.send("warn", args);
  debug = (...args: unknown[]) => this.send("debug", args);
  trace = (...args: unknown[]) => this.send("trace", args);
  info = (...args: unknown[]) => this.send("info", args);
  error = (...args: unknown[]) => this.send("error", args);
}

export const logger = new Logger();
let dispose: (() => void) | undefined;

export function initializeLogging(): () => void {
  if (dispose) return dispose;
  for (const name of ["log", "debug", "info", "warn", "error"] as const) {
    console[name] = (...args: unknown[]) => {
      original[name](...args);
      void logger[name === "log" ? "info" : name](...args);
    };
  }
  const onError = (event: ErrorEvent) => {
    void logger.error("Uncaught error", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void logger.error("Unhandled rejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  dispose = () => {
    Object.assign(console, original);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    dispose = undefined;
  };
  return dispose;
}

if (import.meta.hot) import.meta.hot.dispose(() => dispose?.());
