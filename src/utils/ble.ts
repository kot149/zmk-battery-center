import { invoke } from "@tauri-apps/api/core";

/**
 * @typedef {Object} BleDeviceInfo
 * @property {string} name Device name
 * @property {string} id Device ID
 */
/** @export */
export type BleDeviceInfo = {
	name: string;
	id: string;
};

/**
 * @typedef {Object} BatteryInfo
 * @property {number|null} battery_level Battery level (0-100)
 * @property {string|null} user_descriptor User description
 */
/** @export */
export type BatteryInfo = {
	battery_level: number | null;
	user_descriptor: string | null;
};

export type BatteryInfoNotificationEvent = {
	id: string;
	battery_info: BatteryInfo;
};

export type BatteryMonitorStatusEvent = {
	id: string;
	connected: boolean;
};

/**
 * Get device list
 * @returns {Promise<BleDeviceInfo[]>}
 */
export async function listBatteryDevices(): Promise<BleDeviceInfo[]> {
	return await invoke("list_battery_devices");
}

/**
 * Get battery info for a specified device
 * @param {string} id Device ID
 * @returns {Promise<BatteryInfo[]>}
 */
export async function getBatteryInfo(id: string): Promise<BatteryInfo[]> {
	return await invoke("get_battery_info", { id });
}

/**
 * Start notification-based monitoring for a specified device.
 * Returns the latest battery info snapshot available at monitor start.
 */
export async function startBatteryNotificationMonitor(
	id: string
): Promise<BatteryInfo[]> {
	return await invoke("start_battery_notification_monitor", { id });
}

/**
 * Stop notification-based monitoring for a specified device.
 */
export async function stopBatteryNotificationMonitor(id: string): Promise<void> {
	await invoke("stop_battery_notification_monitor", { id });
}
