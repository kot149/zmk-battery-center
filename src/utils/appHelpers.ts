import type { BatteryInfo } from "./ble";

export type NormalizedRegisteredDevice = {
	id: string;
	name: string;
	batteryInfos: BatteryInfo[];
	isDisconnected: boolean;
};

const DEVICE_ID_PATTERN = /^DeviceId\("(.+)"\)$/;

export function upsertBatteryInfo(batteryInfos: BatteryInfo[], nextInfo: BatteryInfo): BatteryInfo[] {
	const key = nextInfo.user_description ?? null;
	const idx = batteryInfos.findIndex((info) => (info.user_description ?? null) === key);
	if (idx === -1) {
		return [...batteryInfos, nextInfo];
	}
	const next = [...batteryInfos];
	const merged =
		nextInfo.battery_level !== null
			? nextInfo
			: { ...nextInfo, battery_level: batteryInfos[idx].battery_level };
	next[idx] = merged;
	return next;
}

export function mergeBatteryInfos(prev: BatteryInfo[], next: BatteryInfo[]): BatteryInfo[] {
	return next.map((info) => {
		if (info.battery_level !== null) {
			return info;
		}
		const key = info.user_description ?? null;
		const existing = prev.find((p) => (p.user_description ?? null) === key);
		return existing ? { ...info, battery_level: existing.battery_level } : info;
	});
}

export function normalizeLoadedDevices(raw: unknown): NormalizedRegisteredDevice[] {
	const devices = Array.isArray(raw) ? raw : [];
	return devices.map((device): NormalizedRegisteredDevice => {
		const d = typeof device === "object" && device !== null ? (device as Record<string, unknown>) : {};
		const batteryInfos: BatteryInfo[] = Array.isArray(d.batteryInfos)
			? (d.batteryInfos as Array<Record<string, unknown>>).map((info) => {
				const userDesc =
					(info.user_description ?? (info as { user_descriptor?: unknown }).user_descriptor) as
						| string
						| null;
				const level = info.battery_level;
				return {
					battery_level: typeof level === "number" ? level : null,
					user_description: userDesc ?? null,
				};
			})
			: [];
		const rawId = typeof d.id === "string" ? d.id : "";
		const rawName = typeof d.name === "string" ? d.name : "";
		const extractFromDeviceId = (value: string) => {
			const match = value.match(DEVICE_ID_PATTERN);
			return match ? match[1] : value;
		};
		return {
			id: extractFromDeviceId(rawId),
			name: extractFromDeviceId(rawName),
			batteryInfos,
			isDisconnected: d.isDisconnected === true,
		};
	});
}
