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

/** Append all non-null readings for a device, then emit one battery-history-updated event. */
export function recordBatteryReadings(
	device: { name: string; id: string },
	infos: BatteryInfo[],
): void {
	const appendable = infos.filter(info => info.battery_level !== null);
	if (appendable.length === 0) return;
	fireAndForget((async () => {
		for (const info of appendable) {
			await appendBatteryHistory(
				device.name,
				device.id,
				info.user_description ?? 'Central',
				info.battery_level as number,
			);
		}
		await emit('battery-history-updated', { deviceId: device.id });
	})(), `Failed to update battery history for ${device.id}`);
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
