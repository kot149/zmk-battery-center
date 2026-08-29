import { useEffect, useCallback, useRef } from "react";
import { getBatteryInfo } from "@/utils/ble";
import { logger } from "@/utils/log";
import { fireAndForget, sleep } from "@/utils/common";
import { recordBatteryReadings } from "@/utils/batteryHistory";
import { sendNotification } from "@/utils/notification";
import { NotificationType } from "@/utils/config";
import { notifyBatteryEdgeTransitions } from "@/utils/batteryEdgeNotification";
import {
	annotateBatteryInfosFromRead,
	getRegisteredDeviceDisplayName,
	isValidBatteryLevel,
	markBatteryInfosReadFailed,
	mergeBatteryInfos,
	type RegisteredDevice,
} from "@/utils/appHelpers";
import { collapseIfDisconnected, expandIfConnected } from "@/hooks/useRegisteredDevices";
import type { BatteryInfo } from "@/utils/ble";
import type { BatteryRefreshDeviceResult } from "@/utils/externalBatteryIntegration";

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
	ignoreZeroPercent: boolean;
	highBatteryThreshold: number;
	autoCollapseDisconnectedDevices: boolean;
}

function isValidRead(info: BatteryInfo): boolean {
	return isValidBatteryLevel(info.battery_level);
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
	ignoreZeroPercent,
	highBatteryThreshold,
	autoCollapseDisconnectedDevices,
}: UseBatteryPollingOptions) {
	const pushNotificationRef = useRef(pushNotification);
	const pushNotificationWhenRef = useRef(pushNotificationWhen);
	const lowBatteryThresholdRef = useRef(lowBatteryThreshold);
	const ignoreZeroPercentRef = useRef(ignoreZeroPercent);
	const highBatteryThresholdRef = useRef(highBatteryThreshold);
	const autoCollapseDisconnectedDevicesRef = useRef(autoCollapseDisconnectedDevices);
	// Shared by the interval cycle and the manual reload: concurrent
	// get_battery_info calls for one device can tear each other down.
	// External refresh joins the same cycle.
	const cyclePromiseRef = useRef<Promise<BatteryRefreshDeviceResult[]> | null>(null);

	useEffect(() => {
		pushNotificationRef.current = pushNotification;
		pushNotificationWhenRef.current = pushNotificationWhen;
		lowBatteryThresholdRef.current = lowBatteryThreshold;
		ignoreZeroPercentRef.current = ignoreZeroPercent;
		highBatteryThresholdRef.current = highBatteryThreshold;
		autoCollapseDisconnectedDevicesRef.current = autoCollapseDisconnectedDevices;
	}, [pushNotification, pushNotificationWhen, lowBatteryThreshold, ignoreZeroPercent, highBatteryThreshold, autoCollapseDisconnectedDevices]);

	const updateBatteryInfo = useCallback(async (device: RegisteredDevice): Promise<BatteryRefreshDeviceResult> => {
		const isDisconnectedPrev = device.isDisconnected;
		const maxAttempts = isDisconnectedPrev ? 1 : 3;
		let attempts = 0;

		while (attempts < maxAttempts) {
			logger.info(`Updating battery info for: ${device.id} (attempt ${attempts + 1} of ${maxAttempts})`);
			try {
				const info = await getBatteryInfo(device.id);
				const now = Date.now();
				const infoArray = Array.isArray(info) ? info : [info];
				const annotatedInfos = annotateBatteryInfosFromRead(infoArray, now);
				const hasValidRead = annotatedInfos.some(isValidRead);
				commitRegisteredDevices(prev => prev.map(d => {
					if (d.id !== device.id) return d;
					const batteryInfos = annotatedInfos.length > 0
						? mergeBatteryInfos(d.batteryInfos, annotatedInfos)
						: markBatteryInfosReadFailed(d.batteryInfos);
					return expandIfConnected(
						{
							...d,
							batteryInfos,
							isDisconnected: false,
							connectionStatusKnown: true,
							connectionObservedAtUnixMs: now,
						},
						autoCollapseDisconnectedDevicesRef.current,
					);
				}));

				recordBatteryReadings(device, annotatedInfos);

				if (isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Connected]) {
					fireAndForget(
						sendNotification(`${getRegisteredDeviceDisplayName(device)} has been connected.`),
						`Failed to send connected notification for ${device.id}`,
					);
				}

				notifyBatteryEdgeTransitions({
					deviceDisplayName: getRegisteredDeviceDisplayName(device),
					deviceId: device.id,
					prevBatteryInfos: device.batteryInfos,
					newBatteryInfos: annotatedInfos,
					batteryPartLabels: device.batteryPartLabels,
					lowBatteryThreshold: lowBatteryThresholdRef.current,
					ignoreZeroPercent: ignoreZeroPercentRef.current,
					highBatteryThreshold: highBatteryThresholdRef.current,
					pushNotification: pushNotificationRef.current,
					pushNotificationWhen: pushNotificationWhenRef.current,
				});

				return { id: device.id, status: hasValidRead ? "updated" : "unavailable" };
			} catch {
				attempts++;
				if (attempts >= maxAttempts) {
					const now = Date.now();
					commitRegisteredDevices(prev => prev.map(d => {
						if (d.id !== device.id) return d;
						return collapseIfDisconnected(
							{
								...d,
								batteryInfos: markBatteryInfosReadFailed(d.batteryInfos),
								isDisconnected: true,
								connectionStatusKnown: true,
								connectionObservedAtUnixMs: now,
							},
							autoCollapseDisconnectedDevicesRef.current,
						);
					}));

					if (!isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Disconnected]) {
						fireAndForget(
							sendNotification(`${getRegisteredDeviceDisplayName(device)} has been disconnected.`),
							`Failed to send disconnected notification for ${device.id}`,
						);
					}
					return { id: device.id, status: "unavailable" };
				}
			}
			await sleep(500);
		}

		return { id: device.id, status: "unavailable" };
	}, [commitRegisteredDevices]);

	const startRefreshCycle = useCallback(() => {
		if (cyclePromiseRef.current) {
			return cyclePromiseRef.current;
		}
		const cycle = Promise.all(registeredDevicesRef.current.map(updateBatteryInfo));
		let trackedCycle: Promise<BatteryRefreshDeviceResult[]>;
		trackedCycle = cycle.finally(() => {
			if (cyclePromiseRef.current === trackedCycle) {
				cyclePromiseRef.current = null;
			}
		});
		cyclePromiseRef.current = trackedCycle;
		return trackedCycle;
	}, [registeredDevicesRef, updateBatteryInfo]);

	// Polling: use registeredDevicesRef so this effect doesn't re-run on every
	// device update (which would cause an infinite loop).
	useEffect(() => {
		if (!isPollingMode || !isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		let isUnmounted = false;
		const runPollCycle = () => {
			if (isUnmounted) return;
			fireAndForget(startRefreshCycle(), "Polling cycle failed");
		};

		runPollCycle();
		const interval = setInterval(runPollCycle, fetchInterval as number);

		return () => {
			isUnmounted = true;
			clearInterval(interval);
		};
	}, [isPollingMode, isConfigLoaded, isDeviceLoaded, fetchInterval, startRefreshCycle]);

	const reloadAll = useCallback(async () => {
		if (cyclePromiseRef.current) {
			return false;
		}
		await startRefreshCycle();
		return true;
	}, [startRefreshCycle]);

	const refreshAllForExternal = useCallback(
		(): Promise<BatteryRefreshDeviceResult[]> => startRefreshCycle(),
		[startRefreshCycle],
	);

	return {
		updateBatteryInfo,
		reloadAll,
		refreshAllForExternal,
		autoCollapseDisconnectedDevicesRef,
	};
}
