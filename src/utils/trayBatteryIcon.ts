import { invoke } from "@tauri-apps/api/core";
import type { RegisteredDevice } from "@/App";
import type { BatteryInfo } from "@/utils/ble";

export type TrayBatteryIconPayload = {
	enabled: boolean;
	rowCount: 1 | 2;
	centralPercent: number | null;
	peripheralPercent: number | null;
	centralLabel: string | null;
	peripheralLabel: string | null;
	disconnected: boolean;
};

function labelForInfo(info: BatteryInfo | undefined, fallback: "Central" | "Peripheral"): string {
	if (!info?.user_description) {
		return fallback === "Central" ? "C" : "P";
	}
	const raw = info.user_description.trim();
	if (raw.length === 1) return raw.toUpperCase();
	const lower = raw.toLowerCase();
	if (lower === "central") return "C";
	if (lower === "peripheral") return "P";
	return raw.charAt(0).toUpperCase();
}

export function trayBatteryPayloadFromPrimaryDevice(devices: RegisteredDevice[]): TrayBatteryIconPayload {
	if (devices.length === 0) {
		return {
			enabled: false,
			rowCount: 1,
			centralPercent: null,
			peripheralPercent: null,
			centralLabel: null,
			peripheralLabel: null,
			disconnected: false,
		};
	}
	const d = devices[0];
	const infos = d.batteryInfos;
	if (infos.length === 0) {
		return {
			enabled: true,
			rowCount: 1,
			centralPercent: null,
			peripheralPercent: null,
			centralLabel: labelForInfo(undefined, "Central"),
			peripheralLabel: null,
			disconnected: d.isDisconnected,
		};
	}
	if (infos.length === 1) {
		const b = infos[0];
		return {
			enabled: true,
			rowCount: 1,
			centralPercent: b.battery_level ?? null,
			peripheralPercent: null,
			centralLabel: labelForInfo(b, "Central"),
			peripheralLabel: null,
			disconnected: d.isDisconnected,
		};
	}
	const first = infos[0];
	const second = infos[1];
	return {
		enabled: true,
		rowCount: 2,
		centralPercent: first.battery_level ?? null,
		peripheralPercent: second.battery_level ?? null,
		centralLabel: labelForInfo(first, "Central"),
		peripheralLabel: labelForInfo(second, "Peripheral"),
		disconnected: d.isDisconnected,
	};
}

export async function syncTrayBatteryIcon(devices: RegisteredDevice[]): Promise<void> {
	const payload = trayBatteryPayloadFromPrimaryDevice(devices);
	await invoke("update_tray_battery_icon", { payload });
}
