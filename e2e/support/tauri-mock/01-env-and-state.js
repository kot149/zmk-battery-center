(function () {
  const seed =
    typeof window.__E2E_TAURI_SEED__ === "object" && window.__E2E_TAURI_SEED__
      ? window.__E2E_TAURI_SEED__
      : {};

  const STORAGE_PREFIX = "__e2e_tauri_store__";
  const MONITOR_STATE_KEY = "__e2e_monitor_state__";

  function clone(value) {
    return structuredClone(value);
  }

  function localStorageKey(path) {
    return `${STORAGE_PREFIX}:${path}`;
  }

  function readStoreData(path) {
    const raw = window.localStorage.getItem(localStorageKey(path));
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function writeStoreData(path, data) {
    window.localStorage.setItem(localStorageKey(path), JSON.stringify(data));
  }

  function readSavedMonitorState() {
    const raw = window.localStorage.getItem(MONITOR_STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof window.Notification !== "function") {
    class MockNotification {
      static permission = "granted";

      static requestPermission() {
        return Promise.resolve("granted");
      }

      constructor() {}
    }
    window.Notification = MockNotification;
  } else {
    try {
      Object.defineProperty(window.Notification, "permission", {
        configurable: true,
        get() {
          return "granted";
        },
      });
    } catch {}
    window.Notification.requestPermission = () => Promise.resolve("granted");
  }

  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: seed.platform ?? "windows",
    eol: "\r\n",
    version: "10.0",
    family: "windows",
    os_type: "windows",
    arch: "x86_64",
    exe_extension: "exe",
  };

  const saved = readSavedMonitorState();
  const defaultConfig = {
    theme: "dark",
    fetchInterval: 60_000,
    autoStart: false,
    updateCheckEnabled: false,
    autoCollapseDisconnectedDevices: false,
    externalBatterySnapshot: false,
    pushNotification: false,
    pushNotificationWhen: {
      low_battery: true,
      high_battery: true,
      connected: true,
      disconnected: true,
    },
    lowBatteryThreshold: 20,
    ignoreZeroPercent: true,
    highBatteryThreshold: 80,
    manualWindowPositioning: false,
    pinWindow: false,
    windowPosition: { x: 0, y: 0 },
    chartRangeMs: 0,
    chartSmoothingWindowSize: 1_800_000,
    chartCustomRange: null,
    trayIconComponents: ["roleLabel", "batteryIcon", "batteryPercent"],
  };

  const state = {
    nextRid: 1,
    nextEventId: 1,
    ridToPath: new Map(),
    monitors: new Set(),
    invocations: [],
    revision: saved?.revision ?? 0,
    config: clone(saved?.config ?? { ...defaultConfig, ...seed.config }),
    registeredDevices: clone(saved?.devices ?? seed.registeredDevices ?? []),
    devices: clone(
      seed.availableDevices ?? [
        { id: "kbd-1", name: "MockBoard One" },
        { id: "kbd-2", name: "MockBoard Two" },
      ],
    ),
    batteryById: clone(
      seed.batteryById ?? {
        "kbd-1": [{ battery_level: 87, user_description: "Central" }],
        "kbd-2": [{ battery_level: 64, user_description: "Central" }],
      },
    ),
    historyByKey: clone(seed.historyByKey ?? {}),
  };

  function historyKey(deviceName, bleId) {
    return `${deviceName}::${bleId}`;
  }

  function writeSnapshotToStorage() {
    window.localStorage.setItem(
      MONITOR_STATE_KEY,
      JSON.stringify({
        revision: state.revision,
        config: state.config,
        devices: state.registeredDevices,
      }),
    );
  }

  if (seed.config !== undefined) {
    writeStoreData("config.json", { config: clone(seed.config) });
  }

  window.__E2E_TAURI_MOCK_BUILD__ = {
    state,
    clone,
    readStoreData,
    writeStoreData,
    localStorageKey,
    historyKey,
    writeSnapshotToStorage,
  };
})();
