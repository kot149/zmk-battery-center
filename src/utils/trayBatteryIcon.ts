import { invoke } from "@tauri-apps/api/core";
import type { RegisteredDevice } from "@/App";
import type { BatteryInfo } from "@/utils/ble";

export type TrayBatteryIconPayload = {
	enabled: boolean;
	centralPercent: number | null;
	peripheralPercent: number | null;
	centralLabel: string | null;
	peripheralLabel: string | null;
	disconnected: boolean;
};

function roleOfDescription(desc: string | null): "central" | "peripheral" | "unknown" {
	const d = (desc ?? "").toLowerCase();
	if (d.includes("peripheral")) return "peripheral";
	if (d.includes("central")) return "central";
	return "unknown";
}

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

function pickCentralPeripheral(device: RegisteredDevice): {
	central: BatteryInfo | undefined;
	peripheral: BatteryInfo | undefined;
} {
	let central: BatteryInfo | undefined;
	let peripheral: BatteryInfo | undefined;
	const { batteryInfos: infos } = device;
	for (const b of infos) {
		const r = roleOfDescription(b.user_description);
		if (r === "central") central = b;
		else if (r === "peripheral") peripheral = b;
	}
	if (!central && !peripheral && infos.length > 0) {
		if (infos.length >= 2) {
			central = infos[0];
			peripheral = infos[1];
		} else {
			central = infos[0];
		}
		return { central, peripheral };
	}
	// ZMK often exposes only one User Description (e.g. Peripheral). Assign the other row by index.
	const pIdx = peripheral ? infos.indexOf(peripheral) : -1;
	const cIdx = central ? infos.indexOf(central) : -1;
	if (!central) {
		const idx = infos.findIndex((_, i) => i !== pIdx);
		if (idx >= 0) central = infos[idx];
	}
	if (!peripheral) {
		const idx = infos.findIndex((_, i) => i !== cIdx);
		if (idx >= 0) peripheral = infos[idx];
	}
	return { central, peripheral };
}

export function trayBatteryPayloadFromPrimaryDevice(devices: RegisteredDevice[]): TrayBatteryIconPayload {
	if (devices.length === 0) {
		return {
			enabled: false,
			centralPercent: null,
			peripheralPercent: null,
			centralLabel: null,
			peripheralLabel: null,
			disconnected: false,
		};
	}
	const d = devices[0];
	const { central, peripheral } = pickCentralPeripheral(d);
	return {
		enabled: true,
		centralPercent: central?.battery_level ?? null,
		peripheralPercent: peripheral?.battery_level ?? null,
		centralLabel: labelForInfo(central, "Central"),
		peripheralLabel: labelForInfo(peripheral, "Peripheral"),
		disconnected: d.isDisconnected,
	};
}

export async function syncTrayBatteryIcon(devices: RegisteredDevice[]): Promise<void> {
	const payload = trayBatteryPayloadFromPrimaryDevice(devices);
	await invoke("update_tray_battery_icon", { payload });
}
