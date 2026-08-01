import { sendNotification } from "@/utils/notification";
import { fireAndForget } from "@/utils/common";
import { logger } from "@/utils/log";
import { NotificationType } from "@/utils/config";
import { mapIsLowBattery, mapIsHighBattery } from "@/utils/appHelpers";
import {
	defaultBatteryPartDisplayName,
	getBatteryPartDisplayName,
} from "@/utils/batteryLabels";
import type { BatteryInfo } from "@/utils/ble";

interface NotifyBatteryEdgeTransitionsParams {
	deviceDisplayName: string;
	deviceId: string;
	prevBatteryInfos: BatteryInfo[];
	newBatteryInfos: BatteryInfo[];
	batteryPartLabels?: Record<string, string>;
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
	batteryPartLabels,
	lowBatteryThreshold,
	highBatteryThreshold,
	pushNotification,
	pushNotificationWhen,
}: NotifyBatteryEdgeTransitionsParams) {
	const notify = (
		notificationType: NotificationType,
		prev: boolean[],
		curr: boolean[],
		verb: string,
		threshold: number,
	) => {
		if (!pushNotification || !pushNotificationWhen[notificationType]) {
			return;
		}
		for (let i = 0; i < curr.length && i < prev.length; i++) {
			if (prev[i] || !curr[i]) continue;
			const part = newBatteryInfos[i];
			const partDisplayName = getBatteryPartDisplayName(batteryPartLabels, part.user_description);
			const hasCustomPartLabel = partDisplayName !== defaultBatteryPartDisplayName(part.user_description);
			const suffix = newBatteryInfos.length >= 2 || hasCustomPartLabel
				? ' ' + partDisplayName
				: '';
			const message = `${deviceDisplayName}${suffix} battery ${verb} ${threshold}%.`;
			fireAndForget(
				sendNotification(message),
				`Failed to send battery notification for ${deviceId}`,
			);
			logger.info(message);
		}
	};

	notify(
		NotificationType.LowBattery,
		mapIsLowBattery(prevBatteryInfos, lowBatteryThreshold),
		mapIsLowBattery(newBatteryInfos, lowBatteryThreshold),
		'dropped below',
		lowBatteryThreshold,
	);
	notify(
		NotificationType.HighBattery,
		mapIsHighBattery(prevBatteryInfos, highBatteryThreshold),
		mapIsHighBattery(newBatteryInfos, highBatteryThreshold),
		'reached',
		highBatteryThreshold,
	);
}
