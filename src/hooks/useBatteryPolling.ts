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
	autoCollapseDisconnectedDevices,
}: UseBatteryPollingOptions) {
	const pushNotificationRef = useRef(pushNotification);
	const pushNotificationWhenRef = useRef(pushNotificationWhen);
	const autoCollapseDisconnectedDevicesRef = useRef(autoCollapseDisconnectedDevices);
	useEffect(() => {
		pushNotificationRef.current = pushNotification;
		pushNotificationWhenRef.current = pushNotificationWhen;
		autoCollapseDisconnectedDevicesRef.current = autoCollapseDisconnectedDevices;
	}, [pushNotification, pushNotificationWhen, autoCollapseDisconnectedDevices]);

	const updateBatteryInfo = useCallback(async (device: RegisteredDevice) => {
		const isDisconnectedPrev = device.isDisconnected;
		const isLowBatteryPrev = mapIsLowBattery(device.batteryInfos);

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

				if(pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.LowBattery]){
					const isLowBattery = mapIsLowBattery(infoArray);
					const displayName = getRegisteredDeviceDisplayName(device);
					for(let i = 0; i < isLowBattery.length && i < isLowBatteryPrev.length; i++){
						if(!isLowBatteryPrev[i] && isLowBattery[i]){
							fireAndForget(
								sendNotification(`${displayName}${
									infoArray.length >= 2 ?
										' ' + (infoArray[i].user_description ?? 'Central')
										: ''
								} has low battery.`),
								`Failed to send low battery notification for ${device.id}`,
							);
							logger.info(`${displayName} has low battery.`);
						}
					}
				}

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
