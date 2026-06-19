import { useEffect, useCallback, useRef } from "react";
import { getBatteryInfo } from "@/utils/ble";
import { logger } from "@/utils/log";
import { fireAndForget, sleep } from "@/utils/common";
import { emit } from "@tauri-apps/api/event";
import { appendBatteryHistory } from "@/utils/batteryHistory";
import { sendNotification } from "@/utils/notification";
import { NotificationType } from "@/utils/config";
import {
	mergeBatteryInfos,
	mapIsLowBattery,
	mapIsHighBattery,
	getRegisteredDeviceDisplayName,
	type RegisteredDevice,
} from "@/utils/appHelpers";
import { collapseIfDisconnected, expandIfConnected } from "@/hooks/useRegisteredDevices";

interface UseBatteryPollingOptions {
	isPollingMode: boolean;
	isConfigLoaded: boolean;
	isDeviceLoaded: boolean;
	fetchInterval: number | "auto";
	registeredDevicesRef: React.RefObject<RegisteredDevice[]>;
	commitRegisteredDevices: (recipe: (current: RegisteredDevice[]) => RegisteredDevice[]) => void;
	pushNotification: boolean;
	pushNotificationWhen: Record<NotificationType, boolean>;
	lowBatteryThreshold: number;
	highBatteryThreshold: number;
	autoCollapseDisconnectedDevices: boolean;
}

export function useBatteryPolling({
	isPollingMode,
	isConfigLoaded,
	isDeviceLoaded,
	fetchInterval,
	registeredDevicesRef,
	commitRegisteredDevices,
	pushNotification,
	pushNotificationWhen,
	lowBatteryThreshold,
	highBatteryThreshold,
	autoCollapseDisconnectedDevices,
}: UseBatteryPollingOptions) {
	const pushNotificationRef = useRef(pushNotification);
	const pushNotificationWhenRef = useRef(pushNotificationWhen);
	const lowBatteryThresholdRef = useRef(lowBatteryThreshold);
	const highBatteryThresholdRef = useRef(highBatteryThreshold);
	const autoCollapseDisconnectedDevicesRef = useRef(autoCollapseDisconnectedDevices);
	useEffect(() => {
		pushNotificationRef.current = pushNotification;
		pushNotificationWhenRef.current = pushNotificationWhen;
		lowBatteryThresholdRef.current = lowBatteryThreshold;
		highBatteryThresholdRef.current = highBatteryThreshold;
		autoCollapseDisconnectedDevicesRef.current = autoCollapseDisconnectedDevices;
	}, [pushNotification, pushNotificationWhen, lowBatteryThreshold, highBatteryThreshold, autoCollapseDisconnectedDevices]);

	const updateBatteryInfo = useCallback(async (device: RegisteredDevice) => {
		const isDisconnectedPrev = device.isDisconnected;
		const lowThreshold = lowBatteryThresholdRef.current;
		const highThreshold = highBatteryThresholdRef.current;
		const isLowBatteryPrev = mapIsLowBattery(device.batteryInfos, lowThreshold);
		const isHighBatteryPrev = mapIsHighBattery(device.batteryInfos, highThreshold);

		let attempts = 0;
		const maxAttempts = isDisconnectedPrev ? 1 : 3;

		while (attempts < maxAttempts) {
			logger.info(`Updating battery info for: ${device.id} (attempt ${attempts + 1} of ${maxAttempts})`);
			try {
				const info = await getBatteryInfo(device.id);
				const infoArray = Array.isArray(info) ? info : [info];
				commitRegisteredDevices(prev => prev.map(d => {
					if (d.id !== device.id) return d;
					return expandIfConnected(
						{ ...d, batteryInfos: mergeBatteryInfos(d.batteryInfos, infoArray), isDisconnected: false },
						autoCollapseDisconnectedDevicesRef.current,
					);
				}));

				for (const info of infoArray) {
					const batteryLevel = info.battery_level;
					if (batteryLevel !== null) {
						fireAndForget((async () => {
							await appendBatteryHistory(
								device.name,
								device.id,
								info.user_description ?? 'Central',
								batteryLevel,
							);
							await emit('battery-history-updated', { deviceId: device.id });
						})(), `Failed to update battery history for ${device.id}`);
					}
				}

				if(isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Connected]){
					await sendNotification(`${getRegisteredDeviceDisplayName(device)} has been connected.`);
				}

				const displayName = getRegisteredDeviceDisplayName(device);
				const notifyEdgeTransition = (
					notificationType: NotificationType,
					prev: boolean[],
					curr: boolean[],
					label: string,
				) => {
					if (!pushNotificationRef.current || !pushNotificationWhenRef.current[notificationType]) {
						return;
					}
					for (let i = 0; i < curr.length && i < prev.length; i++) {
						if (prev[i] || !curr[i]) continue;
						const suffix = infoArray.length >= 2
							? ' ' + (infoArray[i].user_description ?? 'Central')
							: '';
						const message = `${displayName}${suffix} has ${label} battery.`;
						fireAndForget(
							sendNotification(message),
							`Failed to send ${label} battery notification for ${device.id}`,
						);
						logger.info(`${displayName} has ${label} battery.`);
					}
				};

				notifyEdgeTransition(
					NotificationType.LowBattery,
					isLowBatteryPrev,
					mapIsLowBattery(infoArray, lowThreshold),
					'low',
				);
				notifyEdgeTransition(
					NotificationType.HighBattery,
					isHighBatteryPrev,
					mapIsHighBattery(infoArray, highThreshold),
					'high',
				);

				return;
			} catch {
				attempts++;
				if (attempts >= maxAttempts) {
					commitRegisteredDevices(prev => prev.map(d => {
						if (d.id !== device.id) {
							return d;
						}
						return collapseIfDisconnected(
							{ ...d, isDisconnected: true },
							autoCollapseDisconnectedDevicesRef.current,
						);
					}));

					if(!isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Disconnected]){
						fireAndForget(
							sendNotification(`${getRegisteredDeviceDisplayName(device)} has been disconnected.`),
							`Failed to send disconnected notification for ${device.id}`,
						);
						return;
					}
				}
			}
			await sleep(500);
		}
	}, [commitRegisteredDevices]);

	// Polling: use registeredDevicesRef so this effect doesn't re-run on every
	// device update (which would cause an infinite loop).
	useEffect(() => {
		if (!isPollingMode || !isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		let isUnmounted = false;
		let isPollInFlight = false;

		const runPollCycle = () => {
			if (isUnmounted || isPollInFlight) return;
			isPollInFlight = true;
			fireAndForget(
				Promise.all(registeredDevicesRef.current.map(updateBatteryInfo))
					.finally(() => { isPollInFlight = false; }),
				"Polling cycle failed",
			);
		};

		runPollCycle();

		const interval = setInterval(runPollCycle, fetchInterval as number);

		return () => {
			isUnmounted = true;
			clearInterval(interval);
		};
	}, [isPollingMode, isConfigLoaded, isDeviceLoaded, fetchInterval, updateBatteryInfo, registeredDevicesRef]);

	return { updateBatteryInfo, autoCollapseDisconnectedDevicesRef };
}
