import { invoke } from "@tauri-apps/api/core";
import type { Config } from "@/utils/config";
import type { BleDeviceInfo } from "@/utils/ble";
import type { RegisteredDevice } from "@/utils/app-helpers";

export type MonitorSnapshot = {
  revision: number;
  config: Config;
  devices: RegisteredDevice[];
};

declare global {
  interface Window {
    __INITIAL_MONITOR_STATE__?: MonitorSnapshot;
  }
}

export function getInitialMonitorState(): MonitorSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  const navigationEntries =
    typeof window.performance?.getEntriesByType === "function"
      ? window.performance.getEntriesByType("navigation")
      : [];
  const navigationType = (navigationEntries[0] as PerformanceNavigationTiming | undefined)?.type;
  if (navigationType === "reload") {
    return null;
  }

  return window.__INITIAL_MONITOR_STATE__ ?? null;
}

export type MonitorConfigPatch = Partial<Config>;

export function getMonitorState(): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("get_monitor_state");
}

export function updateMonitorConfig(patch: MonitorConfigPatch): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_update_config", { patch });
}

export function addMonitorDevice(device: BleDeviceInfo): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_add_device", { device });
}

export function removeMonitorDevice(id: string): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_remove_device", { id });
}

export function setMonitorDeviceDisplayName(
  id: string,
  displayName: string | null,
): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_set_device_display_name", { id, displayName });
}

export function setMonitorPartLabel(
  id: string,
  sourceDescription: string | null,
  label: string | null,
): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_set_part_label", {
    id,
    sourceDescription,
    label,
  });
}

export function setMonitorDeviceCollapsed(
  id: string,
  collapsed: boolean,
): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_set_device_collapsed", { id, collapsed });
}

export function reorderMonitorDevices(ids: string[]): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_reorder_devices", { ids });
}

export function reloadMonitor(): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_reload");
}
