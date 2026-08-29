import { invoke } from "@tauri-apps/api/core";
import type { BatteryInfo } from "@/utils/ble";
import { getRegisteredDeviceDisplayName, isValidBatteryLevel } from "@/utils/appHelpers";
import type { RegisteredDevice } from "@/utils/appHelpers";
import { getBatteryPartDisplayName } from "@/utils/batteryLabels";

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

export type RunCatMetric = {
	title: string;
	formattedValue: string;
	normalizedValue?: number;
};

export type RunCatProjection = {
	title: string;
	symbol: string;
	metricsBarValue: string;
	metrics: RunCatMetric[];
};

export type BatteryRefreshDeviceResult = {
	id: string;
	status: "updated" | "unavailable";
};

export type ExternalRefreshRequest = {
	schemaVersion: 1;
	requestId: string;
	requestedAtUnixMs: number;
};

export type RegisteredDevicesSnapshot = {
	devices: RegisteredDevice[];
	sourceRevision: number;
};

export async function publishExternalBatterySnapshot(
	sourceRevision: number,
	devices: ExternalBatteryDevice[],
	runCatProjection: RunCatProjection,
): Promise<void> {
	await invoke("publish_external_battery_snapshot", {
		sourceRevision,
		devices,
		runCatProjection,
	});
}

export async function getPendingExternalBatteryRefresh(): Promise<ExternalRefreshRequest | null> {
	return await invoke<ExternalRefreshRequest | null>("get_pending_external_battery_refresh") ?? null;
}

export async function completeExternalBatteryRefresh(
	requestId: string,
	sourceRevision: number,
	deviceResults: BatteryRefreshDeviceResult[],
	devices: ExternalBatteryDevice[],
	runCatProjection: RunCatProjection,
): Promise<void> {
	await invoke("complete_external_battery_refresh", {
		requestId,
		sourceRevision,
		deviceResults,
		devices,
		runCatProjection,
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

function connectionText(status: ExternalConnectionStatus): string {
	if (status === "connected") return "Connected";
	if (status === "disconnected") return "Disconnected";
	return "Unknown";
}

function batteryMetric(part: ExternalBatteryPart, title: string): RunCatMetric {
	const metric: RunCatMetric = {
		title,
		formattedValue: part.levelPercent === null
			? "N/A"
			: part.valueStatus === "stale"
				? `${part.levelPercent}% (stale)`
				: `${part.levelPercent}%`,
	};
	if (part.levelPercent !== null) {
		metric.normalizedValue = part.levelPercent / 100;
	}
	return metric;
}

export function buildRunCatProjection(devices: RegisteredDevice[]): RunCatProjection {
	const externalDevices = buildExternalBatteryDevices(devices);
	const metrics: RunCatMetric[] = [];
	const compactValues: string[] = [];

	for (const device of externalDevices) {
		metrics.push({
			title: `${device.displayName} / Connection`,
			formattedValue: connectionText(device.connectionStatus),
		});
		for (const part of device.batteryParts) {
			metrics.push(batteryMetric(part, `${device.displayName} / ${part.displayName}`));
			compactValues.push(
				part.levelPercent === null
					? "N/A"
					: `${part.levelPercent}%${part.valueStatus === "stale" ? "*" : ""}`,
			);
		}
	}

	return {
		title: "ZMK Battery Center",
		symbol: "battery.100percent",
		metricsBarValue: compactValues.length > 0 ? compactValues.join(" · ") : "N/A",
		metrics,
	};
}
