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
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [isMonitorHydrationSettled, setIsMonitorHydrationSettled] = useState(false);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const snapshotRef = useRef<MonitorSnapshot | null>(null);
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
    let unlisten: (() => void) | undefined;

    const subscribeAndHydrate = async () => {
      let subscriptionError: string | null = null;

      try {
        const registeredUnlisten = await listen<MonitorSnapshot>(
          "monitor-state-changed",
          (event) => {
            if (!cancelled) {
              applySnapshot(event.payload);
            }
          },
        );

        if (cancelled) {
          registeredUnlisten();
          return;
        }
        unlisten = registeredUnlisten;
      } catch (error) {
        subscriptionError = `Failed to subscribe to monitor state: ${errorMessage(error)}`;
        logger.error(subscriptionError);
      }

      try {
        const initial = await getMonitorState();
        if (!cancelled) {
          applySnapshot(initial);
          if (subscriptionError) {
            setMonitorError(subscriptionError);
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = `Failed to load monitor state: ${errorMessage(error)}`;
          logger.error(message);
          setMonitorError(message);
          setIsMonitorHydrationSettled(true);
        }
      }
    };

    void subscribeAndHydrate();
    return () => {
      cancelled = true;
      unlisten?.();
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
