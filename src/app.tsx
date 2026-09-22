import "./app.css";
import { listBatteryDevices, type BleDeviceInfo } from "./utils/ble";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import Button from "./components/button";
import RegisteredDevicesPanel from "./components/registered-devices-panel";
import { logger } from "./utils/log";
import TopRightButtons from "./components/top-right-buttons";
import { moveWindowToTrayCenter, resizeWindowToContent } from "./utils/window";
import { PlusIcon, ArrowPathIcon, Cog8ToothIcon } from "@heroicons/react/24/outline";
import PushPinIcon from "./components/push-pin-icon";
import Modal from "./components/modal";
import { useConfigContext } from "@/providers/config-provider";
import Settings from "@/components/settings";
import { platform } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";
import { useWindowEvents } from "@/hooks/use-window-events";
import type { RegisteredDevice } from "@/utils/app-helpers";
import { withTimeout } from "@/utils/common";

export type { RegisteredDevice };

enum State {
  main = "main",
  addDeviceModal = "addDeviceModal",
  settings = "settings",
  fetchingDevices = "fetchingDevices",
  fetchingBatteryInfo = "fetchingBatteryInfo",
  chart = "chart",
}

const DEVICE_FETCH_TIMEOUT_MS = 20_000;
const EMPTY_DEVICES: RegisteredDevice[] = [];
const NOOP_SET_DEVICES: Dispatch<SetStateAction<RegisteredDevice[]>> = () => undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const {
    config,
    setConfig,
    isConfigLoaded,
    isMonitorHydrationSettled,
    monitorError,
    registeredDevices,
    isDeviceLoaded,
    addDevice,
    removeDevice,
    setDeviceDisplayName,
    setPartLabel,
    setDeviceCollapsed,
    reorderDevices,
    reloadMonitor,
  } = useConfigContext();
  const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
  const [error, setError] = useState("");
  const [state, setState] = useState<State>(State.main);
  const [panelLayoutRevision, setPanelLayoutRevision] = useState(0);
  const windowReadyRef = useRef(false);
  const isPollingMode = config.fetchInterval !== "auto";
  const deviceList = registeredDevices ?? EMPTY_DEVICES;

  const registeredDeviceIds = useMemo(
    () => new Set(deviceList.map((device) => device.id)),
    [deviceList],
  );
  const availableDevices = useMemo(
    () => devices.filter((device) => !registeredDeviceIds.has(device.id)),
    [devices, registeredDeviceIds],
  );

  const deviceLayoutKey = useMemo(
    () =>
      deviceList
        .map(
          (device) =>
            `${device.id}:${device.isCollapsed}:${device.isDisconnected}:${device.batteryInfos.length}`,
        )
        .join(","),
    [deviceList],
  );

  const handleWindowPositionChange = useCallback(
    (position: { x: number; y: number }) => {
      setConfig((current) => ({ ...current, windowPosition: position }));
    },
    [setConfig],
  );

  useWindowEvents({
    config,
    isConfigLoaded,
    onWindowPositionChange: handleWindowPositionChange,
  });

  const fetchDevices = useCallback(async () => {
    setState(State.fetchingDevices);
    setError("");

    const isMac = platform() === "macos";
    const createTimeoutError = () => {
      let message = "Failed to fetch devices.";
      if (isMac) {
        message += " If you are using macOS, please make sure Bluetooth permission is granted.";
      }
      return new Error(message);
    };

    try {
      const result = await withTimeout(
        listBatteryDevices(),
        DEVICE_FETCH_TIMEOUT_MS,
        createTimeoutError,
      );
      setDevices(result);
      setState(State.addDeviceModal);
    } catch (caughtError: unknown) {
      let message = errorMessage(caughtError);
      if (isMac && !message.includes("Bluetooth permission")) {
        message += " If you are using macOS, please make sure Bluetooth permission is granted.";
      }
      setError(message);
      setState(State.addDeviceModal);
    }
  }, []);

  const handleCloseModal = useCallback(() => {
    setState(State.main);
    setError("");
  }, []);

  const handleAddDevice = useCallback(
    async (id: string) => {
      if (!isDeviceLoaded) return;
      if (registeredDeviceIds.has(id)) {
        handleCloseModal();
        return;
      }

      const device = devices.find((candidate) => candidate.id === id);
      if (!device) return;

      setState(State.fetchingBatteryInfo);
      setError("");
      try {
        await addDevice(device);
        handleCloseModal();
      } catch (caughtError: unknown) {
        setError(`Failed to add device: ${errorMessage(caughtError)}`);
        setState(State.addDeviceModal);
      }
    },
    [addDevice, devices, handleCloseModal, isDeviceLoaded, registeredDeviceIds],
  );

  const handleOpenModal = useCallback(async () => {
    if (!isDeviceLoaded) return;
    setState(State.addDeviceModal);
    await fetchDevices();
  }, [fetchDevices, isDeviceLoaded]);

  const handleRemoveDevice = useCallback(
    async (device: RegisteredDevice) => {
      setError("");
      try {
        await removeDevice(device.id);
      } catch (caughtError: unknown) {
        setError(`Failed to remove device: ${errorMessage(caughtError)}`);
      }
    },
    [removeDevice],
  );

  const handleReload = useCallback(async () => {
    if (!isPollingMode || !isDeviceLoaded) return;
    setState(State.fetchingBatteryInfo);
    setError("");
    try {
      await reloadMonitor();
      setState(State.main);
    } catch (caughtError: unknown) {
      setError(`Failed to reload devices: ${errorMessage(caughtError)}`);
      setState(State.main);
    }
  }, [isDeviceLoaded, isPollingMode, reloadMonitor]);

  const runDeviceMutation = useCallback(async (operation: () => Promise<void>, message: string) => {
    try {
      await operation();
    } catch (caughtError: unknown) {
      setError(`${message}: ${errorMessage(caughtError)}`);
    }
  }, []);

  const handleSetDeviceDisplayName = useCallback(
    (id: string, displayName: string | null) =>
      runDeviceMutation(
        () => setDeviceDisplayName(id, displayName),
        "Failed to save device display name",
      ),
    [runDeviceMutation, setDeviceDisplayName],
  );

  const handleSetPartLabel = useCallback(
    (id: string, sourceDescription: string | null, label: string | null) =>
      runDeviceMutation(
        () => setPartLabel(id, sourceDescription, label),
        "Failed to save battery part label",
      ),
    [runDeviceMutation, setPartLabel],
  );

  const handleSetDeviceCollapsed = useCallback(
    (id: string, collapsed: boolean) =>
      runDeviceMutation(
        () => setDeviceCollapsed(id, collapsed),
        "Failed to save device collapse state",
      ),
    [runDeviceMutation, setDeviceCollapsed],
  );

  const handleReorderDevices = useCallback(
    (ids: string[]) => runDeviceMutation(() => reorderDevices(ids), "Failed to reorder devices"),
    [reorderDevices, runDeviceMutation],
  );

  useEffect(() => {
    let cancelled = false;
    const resizeAndReady = async () => {
      if (!isMonitorHydrationSettled) return;

      if (!windowReadyRef.current) {
        const content = document.getElementById("app");
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (cancelled) return;
          try {
            await invoke("window_ready", {
              width: content?.clientWidth ?? 0,
              height: content?.clientHeight ?? 0,
            });
            windowReadyRef.current = true;
            return;
          } catch (caughtError: unknown) {
            logger.error(`Failed to signal main window readiness: ${errorMessage(caughtError)}`);
          }
        }
        return;
      }

      try {
        await resizeWindowToContent();
      } catch (caughtError: unknown) {
        logger.error(`Failed to resize main window: ${errorMessage(caughtError)}`);
      }
      if (cancelled) return;

      if (isConfigLoaded && isDeviceLoaded && !config.manualWindowPositioning) {
        try {
          await moveWindowToTrayCenter();
        } catch (caughtError: unknown) {
          logger.error(`Failed to position main window: ${errorMessage(caughtError)}`);
        }
      }
    };

    void resizeAndReady();
    return () => {
      cancelled = true;
    };
  }, [
    config.manualWindowPositioning,
    deviceLayoutKey,
    isConfigLoaded,
    isDeviceLoaded,
    isMonitorHydrationSettled,
    panelLayoutRevision,
    state,
  ]);

  const handleExitSettings = useCallback(() => setState(State.main), []);
  const handleOpenSettings = useCallback(() => setState(State.settings), []);
  const handleChartOpenChange = useCallback((isOpen: boolean) => {
    setState(isOpen ? State.chart : State.main);
  }, []);
  const handlePanelLayoutChange = useCallback(() => {
    setPanelLayoutRevision((revision) => revision + 1);
  }, []);

  return (
    <div
      id="app"
      className={`relative flex flex-col bg-background text-foreground rounded-lg p-2 ${
        state === State.main && deviceList.length > 0
          ? "w-90"
          : state === State.chart
            ? "w-110 h-90"
            : state === State.fetchingBatteryInfo
              ? "w-90 min-h-58"
              : state === State.settings
                ? "w-95 min-h-90"
                : "w-90 min-h-90"
      }`}
    >
      {state === State.settings ? (
        <Settings onExit={handleExitSettings} />
      ) : (
        <>
          <div>
            {config.manualWindowPositioning && (
              <div
                data-tauri-drag-region
                className="fixed top-0 left-0 w-full h-14 bg-transparent z-0 cursor-grab active:cursor-grabbing"
              ></div>
            )}

            <div className="flex flex-row items-start">
              <div className="pl-2 pt-0.5">
                <Button
                  className="w-10 h-10 rounded-lg bg-transparent hover:bg-secondary flex items-center justify-center text-2xl p-0! text-foreground relative z-10"
                  onClick={() =>
                    setConfig((current) => ({ ...current, pinWindow: !current.pinWindow }))
                  }
                  aria-label={config.pinWindow ? "Unpin window" : "Pin window"}
                  aria-pressed={config.pinWindow}
                >
                  <PushPinIcon pinned={config.pinWindow} className="size-7" />
                </Button>
              </div>

              <TopRightButtons
                buttons={[
                  {
                    icon: <PlusIcon className="size-5" />,
                    onClick: handleOpenModal,
                    ariaLabel: "Add Device",
                    disabled: !isDeviceLoaded,
                  },
                  {
                    icon: <ArrowPathIcon className="size-5" />,
                    onClick: handleReload,
                    ariaLabel: "Reload",
                    disabled:
                      deviceList.length === 0 ||
                      state === State.fetchingBatteryInfo ||
                      !isPollingMode,
                  },
                  {
                    icon: <Cog8ToothIcon className="size-5" />,
                    onClick: handleOpenSettings,
                    ariaLabel: "Settings",
                  },
                ]}
              />
            </div>
          </div>

          {error && state === State.main && (
            <div role="alert" className="px-2 py-1 text-sm text-destructive">
              {error}
            </div>
          )}

          {monitorError && (
            <div role="alert" className="px-2 py-1 text-sm text-destructive">
              {monitorError}
            </div>
          )}

          {(state === State.addDeviceModal || state === State.fetchingDevices) && (
            <Modal
              open={true}
              onClose={handleCloseModal}
              title="Select Device"
              isLoading={state === State.fetchingDevices}
              error={error}
              loadingText="Fetching devices..."
            >
              {state === State.addDeviceModal && (
                <ul className="app-scrollbar max-h-60 overflow-y-auto rounded-sm">
                  {availableDevices.length === 0 ? (
                    <li className="text-muted-foreground">No devices found</li>
                  ) : (
                    availableDevices.map((device) => (
                      <li key={device.id}>
                        <Button
                          className="w-full text-left rounded-none bg-card text-card-foreground hover:bg-muted transition-colors duration-300 p-2!"
                          onClick={() => handleAddDevice(device.id)}
                        >
                          {device.name}
                        </Button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </Modal>
          )}

          {deviceList.length > 0 ? (
            <main className="container mx-auto">
              <RegisteredDevicesPanel
                registeredDevices={deviceList}
                setRegisteredDevices={NOOP_SET_DEVICES}
                onRemoveDevice={handleRemoveDevice}
                onSetDeviceDisplayName={handleSetDeviceDisplayName}
                onSetPartLabel={handleSetPartLabel}
                onSetDeviceCollapsed={handleSetDeviceCollapsed}
                onReorderDevices={handleReorderDevices}
                onChartOpenChange={handleChartOpenChange}
                onLayoutChange={handlePanelLayoutChange}
              />
            </main>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-6">
              <h1 className="text-2xl text-foreground">No devices registered</h1>
              <Button
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleOpenModal}
                disabled={!isDeviceLoaded}
              >
                Add Device
              </Button>
            </div>
          )}

          <Modal
            open={state === State.fetchingBatteryInfo}
            onClose={() => undefined}
            isLoading={true}
            loadingText="Fetching battery info..."
            showCloseButton={false}
          />
        </>
      )}
    </div>
  );
}

export default App;
