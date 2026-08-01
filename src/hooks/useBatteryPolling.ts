import { useEffect, useCallback, useRef } from "react";
import { getBatteryInfo } from "@/utils/ble";
import { logger } from "@/utils/log";
import { fireAndForget, sleep } from "@/utils/common";
import { recordBatteryReadings } from "@/utils/batteryHistory";
import { sendNotification } from "@/utils/notification";
import { NotificationType } from "@/utils/config";
import { notifyBatteryEdgeTransitions } from "@/utils/batteryEdgeNotification";
import {
	mergeBatteryInfos,
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
	// Shared by the interval cycle and the manual reload: concurrent
	// get_battery_info calls for one device can tear each other down.
	const isCycleInFlightRef = useRef(false);
	useEffect(() => {
		pushNotificationRef.current = pushNotification;
		pushNotificationWhenRef.current = pushNotificationWhen;
		lowBatteryThresholdRef.current = lowBatteryThreshold;
		highBatteryThresholdRef.current = highBatteryThreshold;
		autoCollapseDisconnectedDevicesRef.current = autoCollapseDisconnectedDevices;
	}, [pushNotification, pushNotificationWhen, lowBatteryThreshold, highBatteryThreshold, autoCollapseDisconnectedDevices]);

	const updateBatteryInfo = useCallback(async (device: RegisteredDevice) => {
		const isDisconnectedPrev = device.isDisconnected;

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

				recordBatteryReadings(device, infoArray);

				if(isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Connected]){
					await sendNotification(`${getRegisteredDeviceDisplayName(device)} has been connected.`);
				}

				notifyBatteryEdgeTransitions({
					deviceDisplayName: getRegisteredDeviceDisplayName(device),
					deviceId: device.id,
					prevBatteryInfos: device.batteryInfos,
					newBatteryInfos: infoArray,
					batteryPartLabels: device.batteryPartLabels,
					lowBatteryThreshold: lowBatteryThresholdRef.current,
					highBatteryThreshold: highBatteryThresholdRef.current,
					pushNotification: pushNotificationRef.current,
					pushNotificationWhen: pushNotificationWhenRef.current,
				});

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

		const runPollCycle = () => {
			if (isUnmounted || isCycleInFlightRef.current) return;
			isCycleInFlightRef.current = true;
			fireAndForget(
				Promise.all(registeredDevicesRef.current.map(updateBatteryInfo))
					.finally(() => { isCycleInFlightRef.current = false; }),
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

	const reloadAll = useCallback(async () => {
		if (isCycleInFlightRef.current) {
			return false; // a cycle is already refreshing every device
		}
		isCycleInFlightRef.current = true;
		try {
			await Promise.all(registeredDevicesRef.current.map(updateBatteryInfo));
		} finally {
			isCycleInFlightRef.current = false;
		}
		return true;
	}, [registeredDevicesRef, updateBatteryInfo]);

	return { updateBatteryInfo, reloadAll, autoCollapseDisconnectedDevicesRef };
}
