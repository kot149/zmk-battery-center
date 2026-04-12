(function () {
  const seed = typeof window.__E2E_TAURI_SEED__ === "object" && window.__E2E_TAURI_SEED__
    ? window.__E2E_TAURI_SEED__
    : {};

  const STORAGE_PREFIX = "__e2e_tauri_store__";

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

  if (typeof window.Notification !== "function") {
    class MockNotification {
      static permission = "granted";

      static requestPermission() {
        return Promise.resolve("granted");
      }

      constructor() {
        // no-op
      }
    }
    window.Notification = MockNotification;
  } else {
    try {
      Object.defineProperty(window.Notification, "permission", {
        configurable: true,
        get() {
          return "granted";
        }
      });
    } catch {
      // no-op
    }
    window.Notification.requestPermission = () => Promise.resolve("granted");
  }

  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: seed.platform ?? "windows",
    eol: "\r\n",
    version: "10.0",
    family: "windows",
    os_type: "windows",
    arch: "x86_64",
    exe_extension: "exe"
  };

  const state = {
    nextRid: 1,
    nextEventId: 1,
    ridToPath: new Map(),
    monitors: new Set(),
    invocations: [],
    devices: clone(seed.availableDevices ?? [
      { id: "kbd-1", name: "MockBoard One" },
      { id: "kbd-2", name: "MockBoard Two" }
    ]),
    batteryById: clone(seed.batteryById ?? {
      "kbd-1": [{ battery_level: 87, user_description: "Central" }],
      "kbd-2": [{ battery_level: 64, user_description: "Central" }]
    }),
    historyByKey: clone(seed.historyByKey ?? {})
  };

  if (seed.config !== undefined) {
    writeStoreData("config.json", { config: clone(seed.config) });
  }

  if (seed.registeredDevices !== undefined) {
    writeStoreData("devices.json", { devices: clone(seed.registeredDevices) });
  }

  function historyKey(deviceName, bleId) {
    return `${deviceName}::${bleId}`;
  }

  window.__E2E_TAURI_MOCK_BUILD__ = {
    state,
    clone,
    readStoreData,
    writeStoreData,
    localStorageKey,
    historyKey
  };
})();
