/**
 * Keys in {@link batteryPartLabels} match the canonical part id used in battery history
 * (see appendBatteryHistory: null → "Central") so storage stays aligned with CSV user_description.
 */
export function batteryPartLabelStorageKey(userDescription: string | null | undefined): string {
	return userDescription ?? "Central";
}

export function defaultBatteryPartDisplayName(userDescription: string | null | undefined): string {
	return userDescription ?? "Central";
}

export function getBatteryPartDisplayName(
	batteryPartLabels: Record<string, string> | undefined | null,
	userDescription: string | null | undefined,
): string {
	const key = batteryPartLabelStorageKey(userDescription);
	const custom = batteryPartLabels?.[key];
	if (custom != null && custom.trim() !== "") {
		return custom.trim();
	}
	return defaultBatteryPartDisplayName(userDescription);
}
