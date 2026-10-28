import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logger, setFrontendLogLevel, type LogLevel } from "./log";

export type LogLevelState = { level: LogLevel; generation: number };
declare global {
  interface Window {
    __INITIAL_LOG_LEVEL__?: LogLevelState;
  }
}
let generation = -1;

export function applyLogLevel(state: LogLevelState) {
  if (!state || state.generation < generation) return;
  generation = state.generation;
  setFrontendLogLevel(state.level);
}

export const getLogLevelState = async () => invoke<LogLevelState>("get_log_level_state");
export async function setLogLevel(level: LogLevel) {
  const state = await invoke<LogLevelState>("set_log_level", { level });
  applyLogLevel(state);
  return state;
}
export const openLogsFolder = () => invoke<void>("open_logs_folder");

export function initializeLogLevel(): () => void {
  if (window.__INITIAL_LOG_LEVEL__) applyLogLevel(window.__INITIAL_LOG_LEVEL__);
  let cancelled = false;
  const unlisteners: Array<() => void> = [];
  const refresh = async () => {
    try {
      const state = await getLogLevelState();
      if (!cancelled) applyLogLevel(state);
    } catch (error) {
      void logger.warn("Failed to read log level", error);
    }
  };
  void (async () => {
    for (const event of ["log-level-changed", "main-window-shown"]) {
      try {
        const unlisten = await listen<LogLevelState>(event, ({ payload }) => {
          if (cancelled) return;
          if (event === "log-level-changed") applyLogLevel(payload);
          else void refresh();
        });
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      } catch (error) {
        void logger.warn("Failed to subscribe to log level", error);
      }
    }
    if (!cancelled) await refresh();
  })();
  return () => {
    cancelled = true;
    unlisteners.forEach((unlisten) => unlisten());
  };
}
