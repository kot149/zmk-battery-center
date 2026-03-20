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
    })
  };

  function ensureStore(path) {
    const rid = state.nextRid++;
    state.ridToPath.set(rid, path);
    if (!window.localStorage.getItem(localStorageKey(path))) {
      writeStoreData(path, {});
    }
    return rid;
  }

  if (seed.config !== undefined) {
    writeStoreData("config.json", { config: clone(seed.config) });
  }

  if (seed.registeredDevices !== undefined) {
    writeStoreData("devices.json", { devices: clone(seed.registeredDevices) });
  }

  function getPathFromRid(rid) {
    const path = state.ridToPath.get(rid);
    if (!path) {
      throw new Error(`Unknown store rid: ${String(rid)}`);
    }
    return path;
  }

  function storeGet(rid, key) {
    const data = readStoreData(getPathFromRid(rid));
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return [clone(data[key]), true];
    }
    return [null, false];
  }

  function storeSet(rid, key, value) {
    const path = getPathFromRid(rid);
    const data = readStoreData(path);
    data[key] = clone(value);
    writeStoreData(path, data);
  }

  function storeDelete(rid, key) {
    const path = getPathFromRid(rid);
    const data = readStoreData(path);
    const existed = Object.prototype.hasOwnProperty.call(data, key);
    delete data[key];
    writeStoreData(path, data);
    return existed;
  }

  function storeEntries(rid) {
    const data = readStoreData(getPathFromRid(rid));
    return Object.entries(data).map(([key, value]) => [key, clone(value)]);
  }

  function storeKeys(rid) {
    const data = readStoreData(getPathFromRid(rid));
    return Object.keys(data);
  }

  function storeValues(rid) {
    const data = readStoreData(getPathFromRid(rid));
    return Object.values(data).map(clone);
  }

  function installTauriMocks() {
    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? {};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
    window.__TAURI_INTERNALS__.metadata = {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" }
    };

    const callbacks = new Map();
    const listenersByEvent = new Map();

    function transformCallback(callback, once) {
      const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      callbacks.set(id, (data) => {
        if (once) {
          callbacks.delete(id);
        }
        callback(data);
      });
      return id;
    }

    function runCallback(id, data) {
      const cb = callbacks.get(id);
      if (cb) {
        cb(data);
      }
    }

    function unregisterCallback(id) {
      callbacks.delete(id);
    }

    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = (eventName, eventId) => {
      const listeners = listenersByEvent.get(eventName);
      if (!listeners) return;
      const idx = listeners.indexOf(eventId);
      if (idx !== -1) {
        listeners.splice(idx, 1);
      }
      unregisterCallback(eventId);
    };

    async function invoke(cmd, args) {
      state.invocations.push({ cmd, args: clone(args) });

      if (cmd === "plugin:event|listen") {
        const eventName = args.event;
        const handlerId = args.handler;
        const listeners = listenersByEvent.get(eventName) ?? [];
        listeners.push(handlerId);
        listenersByEvent.set(eventName, listeners);
        return handlerId;
      }

      if (cmd === "plugin:event|unlisten") {
        const listeners = listenersByEvent.get(args.event);
        if (listeners) {
          const idx = listeners.indexOf(args.eventId);
          if (idx !== -1) listeners.splice(idx, 1);
        }
        unregisterCallback(args.eventId);
        return null;
      }

      if (cmd === "plugin:event|emit") {
        const listeners = listenersByEvent.get(args.event) ?? [];
        for (const handlerId of listeners) {
          runCallback(handlerId, {
            event: args.event,
            id: Date.now(),
            payload: clone(args.payload)
          });
        }
        return null;
      }

      if (cmd === "plugin:store|load") {
        return ensureStore(args.path);
      }

      if (cmd === "plugin:store|get_store") {
        return null;
      }

      if (cmd === "plugin:store|get") {
        return storeGet(args.rid, args.key);
      }

      if (cmd === "plugin:store|set") {
        storeSet(args.rid, args.key, args.value);
        return null;
      }

      if (cmd === "plugin:store|has") {
        const [_, exists] = storeGet(args.rid, args.key);
        return exists;
      }

      if (cmd === "plugin:store|delete") {
        return storeDelete(args.rid, args.key);
      }

      if (cmd === "plugin:store|clear" || cmd === "plugin:store|reset") {
        writeStoreData(getPathFromRid(args.rid), {});
        return null;
      }

      if (cmd === "plugin:store|keys") {
        return storeKeys(args.rid);
      }

      if (cmd === "plugin:store|values") {
        return storeValues(args.rid);
      }

      if (cmd === "plugin:store|entries") {
        return storeEntries(args.rid);
      }

      if (cmd === "plugin:store|length") {
        return storeKeys(args.rid).length;
      }

      if (cmd === "plugin:store|reload" || cmd === "plugin:store|save") {
        return null;
      }

      if (cmd === "get_dev_store_path") {
        return null;
      }

      if (cmd === "list_battery_devices") {
        return clone(state.devices);
      }

      if (cmd === "get_battery_info") {
        return clone(state.batteryById[args.id] ?? []);
      }

      if (cmd === "start_battery_notification_monitor") {
        state.monitors.add(args.id);
        return clone(state.batteryById[args.id] ?? []);
      }

      if (cmd === "stop_battery_notification_monitor") {
        state.monitors.delete(args.id);
        return null;
      }

      if (cmd === "stop_all_battery_monitors") {
        state.monitors.clear();
        return null;
      }

      if (cmd === "append_battery_history" || cmd === "read_battery_history") {
        return [];
      }

      if (cmd === "get_windows_text_scale_factor") {
        return 1;
      }

      if (
        cmd === "plugin:positioner|move_window" ||
        cmd === "plugin:window|set_size" ||
        cmd === "plugin:window|show" ||
        cmd === "plugin:window|hide" ||
        cmd === "plugin:window|set_focus" ||
        cmd === "plugin:window|set_position" ||
        cmd === "plugin:window|is_visible" ||
        cmd === "plugin:window|get_all_windows" ||
        cmd === "plugin:window|current_monitor" ||
        cmd === "plugin:tray|get_by_id" ||
        cmd === "plugin:log|log" ||
        cmd === "plugin:autostart|is_enabled" ||
        cmd === "plugin:autostart|enable" ||
        cmd === "plugin:autostart|disable" ||
        cmd === "exit_app"
      ) {
        if (cmd === "plugin:window|is_visible") return true;
        if (cmd === "plugin:window|get_all_windows") return ["main"];
        if (cmd === "plugin:window|current_monitor") return null;
        if (cmd === "plugin:tray|get_by_id") return null;
        if (cmd === "plugin:autostart|is_enabled") return false;
        return null;
      }

      return null;
    }

    window.__TAURI_INTERNALS__.invoke = invoke;
    window.__TAURI_INTERNALS__.transformCallback = transformCallback;
    window.__TAURI_INTERNALS__.unregisterCallback = unregisterCallback;
    window.__TAURI_INTERNALS__.runCallback = runCallback;
    window.__TAURI_INTERNALS__.callbacks = callbacks;

    window.__e2eTauriMock = {
      emit: (eventName, payload) => invoke("plugin:event|emit", { event: eventName, payload }),
      emitBatteryInfo: (id, batteryInfo) => invoke("plugin:event|emit", {
        event: "battery-info-notification",
        payload: { id, battery_info: batteryInfo }
      }),
      emitMonitorStatus: (id, connected) => invoke("plugin:event|emit", {
        event: "battery-monitor-status",
        payload: { id, connected }
      }),
      setBatteryInfo: (id, infos) => {
        state.batteryById[id] = clone(infos);
      },
      getInvocations: () => clone(state.invocations),
      readStore: (path) => clone(readStoreData(path))
    };
  }

  installTauriMocks();
})();
