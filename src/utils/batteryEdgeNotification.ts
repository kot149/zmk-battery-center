import { sendNotification } from "@/utils/notification";
import { fireAndForget } from "@/utils/common";
import { logger } from "@/utils/log";
import { NotificationType } from "@/utils/config";
import { mapIsLowBattery, mapIsHighBattery } from "@/utils/appHelpers";
import type { BatteryInfo } from "@/utils/ble";

interface NotifyBatteryEdgeTransitionsParams {
	deviceDisplayName: string;
	deviceId: string;
	prevBatteryInfos: BatteryInfo[];
	newBatteryInfos: BatteryInfo[];
	lowBatteryThreshold: number;
	highBatteryThreshold: number;
	pushNotification: boolean;
	pushNotificationWhen: Record<NotificationType, boolean>;
}

export function notifyBatteryEdgeTransitions({
	deviceDisplayName,
	deviceId,
	prevBatteryInfos,
	newBatteryInfos,
	lowBatteryThreshold,
	highBatteryThreshold,
	pushNotification,
	pushNotificationWhen,
}: NotifyBatteryEdgeTransitionsParams) {
	const notify = (
		notificationType: NotificationType,
		prev: boolean[],
		curr: boolean[],
		label: string,
	) => {
		if (!pushNotification || !pushNotificationWhen[notificationType]) {
			return;
		}
		for (let i = 0; i < curr.length && i < prev.length; i++) {
			if (prev[i] || !curr[i]) continue;
			const suffix = newBatteryInfos.length >= 2
				? ' ' + (newBatteryInfos[i].user_description ?? 'Central')
				: '';
			const message = `${deviceDisplayName}${suffix} has ${label} battery.`;
			fireAndForget(
				sendNotification(message),
				`Failed to send ${label} battery notification for ${deviceId}`,
			);
			logger.info(`${deviceDisplayName} has ${label} battery.`);
		}
	};

	notify(
		NotificationType.LowBattery,
		mapIsLowBattery(prevBatteryInfos, lowBatteryThreshold),
		mapIsLowBattery(newBatteryInfos, lowBatteryThreshold),
		'low',
	);
	notify(
		NotificationType.HighBattery,
		mapIsHighBattery(prevBatteryInfos, highBatteryThreshold),
		mapIsHighBattery(newBatteryInfos, highBatteryThreshold),
		'high',
	);
}
