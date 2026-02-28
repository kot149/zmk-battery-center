import { invoke } from "@tauri-apps/api/core";

export type BatteryHistoryRecord = {
	timestamp: string;
	user_description: string;
	battery_level: number;
};

export async function appendBatteryHistory(
	deviceName: string,
	bleId: string,
	userDescription: string,
	batteryLevel: number,
): Promise<void> {
	const timestamp = new Date().toISOString();
	await invoke("append_battery_history", {
		deviceName,
		bleId,
		timestamp,
		userDescription,
		batteryLevel,
	});
}

export async function readBatteryHistory(
	deviceName: string,
	bleId: string,
): Promise<BatteryHistoryRecord[]> {
	return invoke<BatteryHistoryRecord[]>("read_battery_history", {
		deviceName,
		bleId,
	});
}
