import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { fireAndForget } from "@/utils/common";
import type { BatteryInfo } from "@/utils/ble";

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
	timestamp: string = new Date().toISOString(),
): Promise<void> {
	await invoke("append_battery_history", {
		deviceName,
		bleId,
		timestamp,
		userDescription,
		batteryLevel,
	});
}

/** Append all non-null readings for a device, then emit one battery-history-updated event. */
export function recordBatteryReadings(
	device: { name: string; id: string },
	infos: BatteryInfo[],
): void {
	const records: BatteryHistoryRecord[] = infos
		.filter(info => info.battery_level !== null)
		.map(info => ({
			timestamp: new Date().toISOString(),
			user_description: info.user_description ?? 'Central',
			battery_level: info.battery_level as number,
		}));
	if (records.length === 0) return;
	fireAndForget((async () => {
		for (const record of records) {
			await appendBatteryHistory(
				device.name,
				device.id,
				record.user_description,
				record.battery_level,
				record.timestamp,
			);
		}
		await emit('battery-history-updated', { deviceId: device.id, records });
	})(), `Failed to update battery history for ${device.id}`);
}

export async function readBatteryHistory(
	deviceName: string,
	bleId: string,
	since?: string,
): Promise<BatteryHistoryRecord[]> {
	return invoke<BatteryHistoryRecord[]>("read_battery_history", {
		deviceName,
		bleId,
		since: since ?? null,
	});
}
