import { invoke } from "@tauri-apps/api/core";
import type { BatteryInfo } from "@/utils/ble";
import { getRegisteredDeviceDisplayName, isValidBatteryLevel } from "@/utils/app-helpers";
import type { RegisteredDevice } from "@/utils/app-helpers";
import { getBatteryPartDisplayName } from "@/utils/battery-labels";

export type ExternalConnectionStatus = "unknown" | "connected" | "disconnected";
export type ExternalBatteryValueStatus = "current" | "stale" | "unavailable";

export type ExternalBatteryPart = {
	id: string;
	sourceDescription: string | null;
	displayName: string;
	levelPercent: number | null;
	observedAtUnixMs: number | null;
	valueStatus: ExternalBatteryValueStatus;
};

export type ExternalBatteryDevice = {
	id: string;
	key: string;
	name: string;
	displayName: string;
	connectionStatus: ExternalConnectionStatus;
	connectionObservedAtUnixMs: number | null;
	batteryParts: ExternalBatteryPart[];
};

export type RegisteredDevicesSnapshot = {
	devices: RegisteredDevice[];
	sourceRevision: number;
};

export async function startExternalBatterySourceSession(): Promise<number> {
	return await invoke("start_external_battery_source_session");
}

export async function publishExternalBatterySnapshot(
	sourceGeneration: number,
	sourceRevision: number,
	devices: ExternalBatteryDevice[],
): Promise<void> {
	await invoke("publish_external_battery_snapshot", {
		sourceGeneration,
		sourceRevision,
		devices,
	});
}

export function toStableExternalKey(prefix: string, value: string): string {
	const bytes = new TextEncoder().encode(value);
	return `${prefix}${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function getExternalBatteryPartId(userDescription: string | null): string {
	return userDescription === null ? "central" : toStableExternalKey("part", userDescription);
}

function connectionStatusFor(device: RegisteredDevice): ExternalConnectionStatus {
	if (device.connectionStatusKnown !== true) return "unknown";
	return device.isDisconnected ? "disconnected" : "connected";
}

function validTimestamp(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function getValueStatus(
	level: number | null,
	connectionStatus: ExternalConnectionStatus,
	lastReadSucceeded: boolean | undefined,
): ExternalBatteryValueStatus {
	if (level === null) return "unavailable";
	if (connectionStatus !== "connected") return "stale";
	if (lastReadSucceeded !== true) return "stale";
	return "current";
}

export function buildExternalBatteryDevices(devices: RegisteredDevice[]): ExternalBatteryDevice[] {
	return devices.map((device) => {
		const connectionStatus = connectionStatusFor(device);
		return {
			id: device.id,
			key: toStableExternalKey("device", device.id),
			name: device.name,
			displayName: getRegisteredDeviceDisplayName(device),
			connectionStatus,
			connectionObservedAtUnixMs: connectionStatus === "unknown"
				? null
				: validTimestamp(device.connectionObservedAtUnixMs),
			batteryParts: device.batteryInfos.map((info: BatteryInfo) => {
				const level = isValidBatteryLevel(info.battery_level) ? info.battery_level : null;
				const valueStatus = getValueStatus(level, connectionStatus, info.last_read_succeeded);
				return {
					id: getExternalBatteryPartId(info.user_description),
					sourceDescription: info.user_description,
					displayName: getBatteryPartDisplayName(device.batteryPartLabels, info.user_description),
					levelPercent: level,
					observedAtUnixMs: validTimestamp(info.observed_at_unix_ms),
					valueStatus,
				};
			}),
		};
	});
}
