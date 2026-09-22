import {
  createContext,
  useContext,
  Dispatch,
  SetStateAction,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { useTheme, type Theme } from "@/providers/theme-provider";
import { defaultConfig, type Config } from "@/utils/config";
import type { BleDeviceInfo } from "@/utils/ble";
import type { RegisteredDevice } from "@/utils/app-helpers";
import {
  addMonitorDevice,
  getInitialMonitorState,
  getMonitorState,
  reloadMonitor as reloadMonitorState,
  removeMonitorDevice,
  reorderMonitorDevices,
  setMonitorDeviceCollapsed,
  setMonitorDeviceDisplayName,
  setMonitorPartLabel,
  type MonitorConfigPatch,
  type MonitorSnapshot,
  updateMonitorConfig,
} from "@/utils/monitor";
import { logger } from "@/utils/log";

type ConfigContextType = {
  config: Config;
  setConfig: Dispatch<SetStateAction<Config>>;
  isConfigLoaded: boolean;
  isMonitorHydrationSettled: boolean;
  monitorError: string | null;
  registeredDevices: RegisteredDevice[] | undefined;
  isDeviceLoaded: boolean;
  addDevice: (device: BleDeviceInfo) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
  setDeviceDisplayName: (id: string, displayName: string | null) => Promise<void>;
  setPartLabel: (
    id: string,
    sourceDescription: string | null,
    label: string | null,
  ) => Promise<void>;
  setDeviceCollapsed: (id: string, collapsed: boolean) => Promise<void>;
  reorderDevices: (ids: string[]) => Promise<void>;
  reloadMonitor: () => Promise<void>;
};

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configPatch(previous: Config, next: Config): MonitorConfigPatch {
  const patch: MonitorConfigPatch = {};
  for (const key of Object.keys(next) as Array<keyof Config>) {
    if (!Object.is(previous[key], next[key])) {
      patch[key] = next[key] as never;
    }
  }
  return patch;
}

export const ConfigProvider = ({ children }: { children: ReactNode }) => {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(getInitialMonitorState);
  const [isMonitorHydrationSettled, setIsMonitorHydrationSettled] = useState(
    () => snapshot !== null,
  );
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const snapshotRef = useRef<MonitorSnapshot | null>(snapshot);
  const { setTheme } = useTheme();

  const applySnapshot = useCallback(
    (next: MonitorSnapshot, allowSameRevision = false) => {
      const previous = snapshotRef.current;
      if (
        previous &&
        (next.revision < previous.revision ||
          (next.revision === previous.revision && !allowSameRevision))
      ) {
        return;
      }
      snapshotRef.current = next;
      setSnapshot(next);
      setIsMonitorHydrationSettled(true);
      setMonitorError(null);
      setTheme(next.config.theme as Theme);
    },
    [setTheme],
  );

  useEffect(() => {
    if (snapshot) {
      setTheme(snapshot.config.theme as Theme);
    }
  }, [setTheme, snapshot]);

  const runMonitorCommand = useCallback(
    async (command: () => Promise<MonitorSnapshot>): Promise<void> => {
      try {
        const next = await command();
        applySnapshot(next);
      } catch (error) {
        logger.error(`Monitor command failed: ${String(error)}`);
        throw error;
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const subscriptionErrors: string[] = [];

    const refreshMonitorState = async (): Promise<MonitorSnapshot | null> => {
      if (cancelled) return null;
      try {
        const next = await getMonitorState();
        if (!cancelled) {
          applySnapshot(next);
        }
        return next;
      } catch (error: unknown) {
        if (!cancelled) {
          const message = `Failed to load monitor state: ${errorMessage(error)}`;
          logger.error(message);
          setMonitorError(message);
        }
        return null;
      }
    };

    const subscribe = <T,>(
      eventName: string,
      handler: (event: { payload: T }) => void,
      errorMessagePrefix: string,
    ) =>
      listen<T>(eventName, handler)
        .then((unlisten) => {
          if (cancelled) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        })
        .catch((error: unknown) => {
          const message = `${errorMessagePrefix}: ${errorMessage(error)}`;
          subscriptionErrors.push(message);
          logger.error(message);
        });

    const subscribeAndHydrate = async () => {
      await Promise.all([
        subscribe<MonitorSnapshot>(
          "monitor-state-changed",
          (event) => {
            if (!cancelled) {
              applySnapshot(event.payload);
            }
          },
          "Failed to subscribe to monitor state",
        ),
        subscribe<void>(
          "main-window-shown",
          () => {
            void refreshMonitorState();
          },
          "Failed to subscribe to main window shown event",
        ),
      ]);
      if (cancelled) {
        return;
      }

      const initial = await refreshMonitorState();
      if (!cancelled && initial && subscriptionErrors.length > 0) {
        setMonitorError(subscriptionErrors.join("; "));
      }
      if (!cancelled && initial === null) {
        setIsMonitorHydrationSettled(true);
      }
    };

    void subscribeAndHydrate();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [applySnapshot]);

  const setConfig = useCallback<Dispatch<SetStateAction<Config>>>(
    (updates) => {
      const currentSnapshot = snapshotRef.current;
      if (!currentSnapshot) {
        return;
      }

      const previous = currentSnapshot.config;
      const next = typeof updates === "function" ? updates(previous) : updates;
      const patch = configPatch(previous, next);
      if (Object.keys(patch).length === 0) {
        return;
      }

      const optimisticConfig: Config = { ...previous, ...next };
      const optimistic: MonitorSnapshot = {
        ...currentSnapshot,
        config: optimisticConfig,
      };
      snapshotRef.current = optimistic;
      setSnapshot(optimistic);
      setTheme(optimisticConfig.theme as Theme);
      void runMonitorCommand(() => updateMonitorConfig(patch)).catch(async () => {
        try {
          const latest = await getMonitorState();
          applySnapshot(latest, true);
        } catch (rollbackError) {
          logger.error(
            `Failed to recover monitor state after config update: ${String(rollbackError)}`,
          );
        }
      });
    },
    [applySnapshot, runMonitorCommand, setTheme],
  );

  const addDevice = useCallback(
    (device: BleDeviceInfo) => runMonitorCommand(() => addMonitorDevice(device)),
    [runMonitorCommand],
  );
  const removeDevice = useCallback(
    (id: string) => runMonitorCommand(() => removeMonitorDevice(id)),
    [runMonitorCommand],
  );
  const setDeviceDisplayName = useCallback(
    (id: string, displayName: string | null) =>
      runMonitorCommand(() => setMonitorDeviceDisplayName(id, displayName)),
    [runMonitorCommand],
  );
  const setPartLabel = useCallback(
    (id: string, sourceDescription: string | null, label: string | null) =>
      runMonitorCommand(() => setMonitorPartLabel(id, sourceDescription, label)),
    [runMonitorCommand],
  );
  const setDeviceCollapsed = useCallback(
    (id: string, collapsed: boolean) =>
      runMonitorCommand(() => setMonitorDeviceCollapsed(id, collapsed)),
    [runMonitorCommand],
  );
  const reorderDevices = useCallback(
    (ids: string[]) => runMonitorCommand(() => reorderMonitorDevices(ids)),
    [runMonitorCommand],
  );
  const reloadMonitor = useCallback(
    () => runMonitorCommand(() => reloadMonitorState()),
    [runMonitorCommand],
  );

  const contextValue = useMemo<ConfigContextType>(
    () => ({
      config: snapshot?.config ?? defaultConfig,
      setConfig,
      isConfigLoaded: snapshot !== null,
      isMonitorHydrationSettled,
      monitorError,
      registeredDevices: snapshot?.devices,
      isDeviceLoaded: snapshot !== null,
      addDevice,
      removeDevice,
      setDeviceDisplayName,
      setPartLabel,
      setDeviceCollapsed,
      reorderDevices,
      reloadMonitor,
    }),
    [
      addDevice,
      reloadMonitor,
      removeDevice,
      reorderDevices,
      setConfig,
      isMonitorHydrationSettled,
      monitorError,
      setDeviceCollapsed,
      setDeviceDisplayName,
      setPartLabel,
      snapshot,
    ],
  );

  return <ConfigContext.Provider value={contextValue}>{children}</ConfigContext.Provider>;
};

export function useConfigContext(): ConfigContextType {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfigContext must be used within a ConfigProvider");
  }
  return context;
}
