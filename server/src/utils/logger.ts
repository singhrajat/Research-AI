import { env } from "../config/env";

type LogLevel = "info" | "warn" | "error";
type LogStatus = "START" | "SUCCESS" | "FAILURE" | "INFO";
type ScopeMessageMeta = [scope: string, message: string, meta?: unknown] | [message: string, meta?: unknown];

function shouldLog(): boolean {
  return !env.stopAllLogs;
}

function emit(level: LogLevel, scope: string, status: LogStatus, message: string, meta?: unknown): void {
  if (!shouldLog()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${scope}] [${status}]`;
  if (meta === undefined) {
    console[level](`${prefix} ${message}`);
    return;
  }

  console[level](`${prefix} ${message}`, meta);
}

export const logger = {
  info: (...args: ScopeMessageMeta) => {
    if (args.length === 1 || typeof args[1] !== "string") {
      const [message, meta] = args;
      emit("info", "app", "INFO", message, meta);
      return;
    }
    const [scope, message, meta] = args;
    emit("info", scope, "INFO", message, meta);
  },
  warn: (...args: ScopeMessageMeta) => {
    if (args.length === 1 || typeof args[1] !== "string") {
      const [message, meta] = args;
      emit("warn", "app", "INFO", message, meta);
      return;
    }
    const [scope, message, meta] = args;
    emit("warn", scope, "INFO", message, meta);
  },
  error: (...args: ScopeMessageMeta) => {
    if (args.length === 1 || typeof args[1] !== "string") {
      const [message, meta] = args;
      emit("error", "app", "FAILURE", message, meta);
      return;
    }
    const [scope, message, meta] = args;
    emit("error", scope, "FAILURE", message, meta);
  },
  stepStart: (scope: string, message: string, meta?: unknown) => emit("info", scope, "START", message, meta),
  stepSuccess: (scope: string, message: string, meta?: unknown) => emit("info", scope, "SUCCESS", message, meta),
  stepFailure: (scope: string, message: string, meta?: unknown) => emit("error", scope, "FAILURE", message, meta),
};

