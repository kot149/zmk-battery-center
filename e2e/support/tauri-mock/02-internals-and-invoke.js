(function () {
  const build = window.__E2E_TAURI_MOCK_BUILD__;
  if (!build || typeof build !== "object") {
    throw new Error("E2E Tauri mock: run 01-env-and-state.js before 02-internals-and-invoke.js");
  }

  const { state, clone, readStoreData, writeStoreData, historyKey, writeSnapshotToStorage } = build;

  function getPathFromRid(rid) {
    const path = state.ridToPath.get(rid);
    if (!path) throw new Error(`Unknown store rid: ${String(rid)}`);
    return path;
  }

  function ensureStore(path) {
    const rid = state.nextRid++;
    state.ridToPath.set(rid, path);
    if (!window.localStorage.getItem(build.localStorageKey(path))) writeStoreData(path, {});
    return rid;
  }

  function storeGet(rid, key) {
    const data = readStoreData(getPathFromRid(rid));
    return Object.prototype.hasOwnProperty.call(data, key)
      ? [clone(data[key]), true]
      : [null, false];
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
    return Object.entries(readStoreData(getPathFromRid(rid))).map(([key, value]) => [
      key,
      clone(value),
    ]);
  }

  function storeKeys(rid) {
    return Object.keys(readStoreData(getPathFromRid(rid)));
  }

  function storeValues(rid) {
    return Object.values(readStoreData(getPathFromRid(rid))).map(clone);
  }

  function snapshot() {
    return clone({
      revision: state.revision,
      config: state.config,
      devices: state.registeredDevices,
    });
  }

  function emitEvent(eventName, payload) {
    const listeners = listenersByEvent.get(eventName) ?? [];
    for (const handlerId of listeners.slice()) {
      runCallbackForEvent(handlerId, {
        event: eventName,
        id: state.nextEventId++,
        payload: clone(payload),
      });
    }
  }

  function commit(mutator) {
    mutator();
    state.revision += 1;
    writeSnapshotToStorage();
    const next = snapshot();
    emitEvent("monitor-state-changed", next);
    return next;
  }

  function infoKey(info) {
    return info.user_description ?? null;
  }

  function annotateInfos(infos, previous = []) {
    const now = Date.now();
    return infos.map((info) => {
      const old = previous.find((candidate) => infoKey(candidate) === infoKey(info));
      if (info.battery_level === null && old?.battery_level != null) {
        return {
          ...info,
          battery_level: old.battery_level,
          observed_at_unix_ms: old.observed_at_unix_ms ?? null,
          last_read_succeeded: false,
        };
      }
      return {
        ...info,
        observed_at_unix_ms: info.battery_level == null ? null : now,
        last_read_succeeded: info.battery_level != null,
      };
    });
  }

  function updateDeviceBattery(deviceId, infos) {
    const device = state.registeredDevices.find((candidate) => candidate.id === deviceId);
    if (!device) return;
    device.batteryInfos = annotateInfos(infos, device.batteryInfos ?? []);
    device.isDisconnected = false;
    device.connectionStatusKnown = true;
    device.connectionObservedAtUnixMs = Date.now();
    if (state.config.autoCollapseDisconnectedDevices && device.isCollapsed) {
      device.isCollapsed = false;
    }
  }

  function normalizeDevice(device) {
    const infos = clone(state.batteryById[device.id] ?? []);
    const now = Date.now();
    const disconnected = infos.length === 0;
    return {
      ...clone(device),
      batteryInfos: annotateInfos(infos),
      isDisconnected: disconnected,
      isCollapsed: disconnected && state.config.autoCollapseDisconnectedDevices,
      connectionStatusKnown: true,
      connectionObservedAtUnixMs: now,
    };
  }

  function setDisconnected(id, connected) {
    const device = state.registeredDevices.find((candidate) => candidate.id === id);
    if (!device) return;
    device.isDisconnected = !connected;
    device.connectionStatusKnown = true;
    device.connectionObservedAtUnixMs = Date.now();
    if (device.isDisconnected && state.config.autoCollapseDisconnectedDevices) {
      device.isCollapsed = true;
    } else if (!device.isDisconnected && state.config.autoCollapseDisconnectedDevices) {
      device.isCollapsed = false;
    }
    if (device.isDisconnected) {
      device.batteryInfos = (device.batteryInfos ?? []).map((info) => ({
        ...info,
        last_read_succeeded: false,
      }));
    }
  }

  function installTauriMocks() {
    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? {};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
    window.__TAURI_INTERNALS__.metadata = {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    };

    const callbacks = new Map();
    listenersByEvent = new Map();

    function transformCallback(callback, once) {
      const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        callback(data);
      });
      return id;
    }

    function runCallback(id, data) {
      const callback = callbacks.get(id);
      if (callback) callback(data);
    }
    runCallbackForEvent = runCallback;

    function unregisterCallback(id) {
      callbacks.delete(id);
    }

    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = (eventName, eventId) => {
      const listeners = listenersByEvent.get(eventName);
      if (!listeners) return;
      const index = listeners.indexOf(eventId);
      if (index !== -1) listeners.splice(index, 1);
      unregisterCallback(eventId);
    };

    async function invoke(cmd, args = {}) {
      state.invocations.push({ cmd, args: clone(args) });

      if (cmd === "plugin:event|listen") {
        const listeners = listenersByEvent.get(args.event) ?? [];
        listeners.push(args.handler);
        listenersByEvent.set(args.event, listeners);
        return args.handler;
      }
      if (cmd === "plugin:event|unlisten") {
        const listeners = listenersByEvent.get(args.event);
        if (listeners) {
          const index = listeners.indexOf(args.eventId);
          if (index !== -1) listeners.splice(index, 1);
        }
        unregisterCallback(args.eventId);
        return null;
      }
      if (cmd === "plugin:event|emit") {
        emitEvent(args.event, args.payload);
        return null;
      }

      if (cmd === "plugin:store|load") return ensureStore(args.path);
      if (cmd === "plugin:store|get_store") return null;
      if (cmd === "plugin:store|get") return storeGet(args.rid, args.key);
      if (cmd === "plugin:store|set") {
        storeSet(args.rid, args.key, args.value);
        return null;
      }
      if (cmd === "plugin:store|has") return storeGet(args.rid, args.key)[1];
      if (cmd === "plugin:store|delete") return storeDelete(args.rid, args.key);
      if (cmd === "plugin:store|clear" || cmd === "plugin:store|reset") {
        writeStoreData(getPathFromRid(args.rid), {});
        return null;
      }
      if (cmd === "plugin:store|keys") return storeKeys(args.rid);
      if (cmd === "plugin:store|values") return storeValues(args.rid);
      if (cmd === "plugin:store|entries") return storeEntries(args.rid);
      if (cmd === "plugin:store|length") return storeKeys(args.rid).length;
      if (cmd === "plugin:store|reload" || cmd === "plugin:store|save") return null;

      if (cmd === "get_dev_store_path") return null;
      if (cmd === "get_windows_text_scale_factor") return 1;
      if (cmd === "window_ready") return null;

      if (cmd === "get_monitor_state") return snapshot();
      if (cmd === "monitor_is_update_dismissed") {
        const versions = readStoreData("config.json").dismissedVersions;
        return Array.isArray(versions) && versions.includes(args.version);
      }
      if (cmd === "monitor_dismiss_update") {
        const data = readStoreData("config.json");
        const versions = Array.isArray(data.dismissedVersions)
          ? data.dismissedVersions.filter((value) => typeof value === "string")
          : [];
        if (!versions.includes(args.version)) {
          data.dismissedVersions = [...versions, args.version];
          writeStoreData("config.json", data);
        }
        return null;
      }
      if (cmd === "monitor_update_config") {
        return commit(() => {
          state.config = { ...state.config, ...clone(args.patch) };
        });
      }
      if (cmd === "monitor_add_device") {
        if (state.registeredDevices.some((device) => device.id === args.device.id))
          return snapshot();
        return commit(() => {
          state.registeredDevices.push(normalizeDevice(args.device));
        });
      }
      if (cmd === "monitor_remove_device") {
        return commit(() => {
          state.registeredDevices = state.registeredDevices.filter(
            (device) => device.id !== args.id,
          );
        });
      }
      if (cmd === "monitor_set_device_display_name") {
        return commit(() => {
          const device = state.registeredDevices.find((candidate) => candidate.id === args.id);
          if (!device) return;
          if (args.displayName == null) delete device.displayName;
          else device.displayName = args.displayName;
        });
      }
      if (cmd === "monitor_set_part_label") {
        return commit(() => {
          const device = state.registeredDevices.find((candidate) => candidate.id === args.id);
          if (!device) return;
          const key = args.sourceDescription ?? "Central";
          const labels = { ...device.batteryPartLabels };
          if (args.label == null) delete labels[key];
          else labels[key] = args.label;
          if (Object.keys(labels).length > 0) device.batteryPartLabels = labels;
          else delete device.batteryPartLabels;
        });
      }
      if (cmd === "monitor_set_device_collapsed") {
        return commit(() => {
          const device = state.registeredDevices.find((candidate) => candidate.id === args.id);
          if (device) device.isCollapsed = args.collapsed;
        });
      }
      if (cmd === "monitor_reorder_devices") {
        return commit(() => {
          const byId = new Map(state.registeredDevices.map((device) => [device.id, device]));
          state.registeredDevices = args.ids.map((id) => byId.get(id)).filter(Boolean);
        });
      }
      if (cmd === "monitor_reload") {
        return commit(() => {
          for (const device of state.registeredDevices) {
            updateDeviceBattery(device.id, state.batteryById[device.id] ?? []);
          }
        });
      }

      if (cmd === "list_battery_devices") return clone(state.devices);
      if (cmd === "read_battery_history") {
        const records = state.historyByKey[historyKey(args.deviceName, args.bleId)] ?? [];
        return clone(
          args.since ? records.filter((record) => record.timestamp >= args.since) : records,
        );
      }

      if (cmd === "plugin:autostart|is_enabled") return false;
      if (
        cmd === "plugin:autostart|enable" ||
        cmd === "plugin:autostart|disable" ||
        cmd === "plugin:log|log" ||
        cmd === "plugin:positioner|move_window" ||
        cmd === "plugin:window|set_size" ||
        cmd === "plugin:window|show" ||
        cmd === "plugin:window|hide" ||
        cmd === "plugin:window|set_focus" ||
        cmd === "plugin:window|set_position" ||
        cmd === "plugin:window|set_always_on_top" ||
        cmd === "plugin:window|is_visible" ||
        cmd === "plugin:window|get_all_windows" ||
        cmd === "plugin:window|current_monitor" ||
        cmd === "plugin:tray|get_by_id" ||
        cmd === "exit_app"
      ) {
        if (cmd === "plugin:window|is_visible") return true;
        if (cmd === "plugin:window|get_all_windows") return ["main"];
        if (cmd === "plugin:window|current_monitor") return null;
        if (cmd === "plugin:tray|get_by_id") return null;
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
      emitBatteryInfo: async (id, batteryInfo) => {
        commit(() => updateDeviceBattery(id, [batteryInfo]));
      },
      emitMonitorStatus: async (id, connected) => {
        commit(() => setDisconnected(id, connected));
      },
      setBatteryInfo: (id, infos) => {
        state.batteryById[id] = clone(infos);
      },
      setHistory: (deviceName, bleId, records) => {
        state.historyByKey[historyKey(deviceName, bleId)] = clone(records);
      },
      getInvocations: () => clone(state.invocations),
      readStore: (path) => clone(readStoreData(path)),
    };
  }

  let listenersByEvent = new Map();
  let runCallbackForEvent = () => {};
  installTauriMocks();
  delete window.__E2E_TAURI_MOCK_BUILD__;
})();
