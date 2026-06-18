import { useEffect, useRef } from "react";
import {
	startBatteryNotificationMonitor,
	stopBatteryNotificationMonitor,
	stopAllBatteryMonitors,
} from "@/utils/ble";
import { logger } from "@/utils/log";
import { fireAndForget } from "@/utils/common";
import { mergeBatteryInfos, type RegisteredDevice } from "@/utils/appHelpers";
import { collapseIfDisconnected, expandIfConnected } from "@/hooks/useRegisteredDevices";

interface UseNotificationMonitorsOptions {
	isNotificationMonitorMode: boolean;
	isConfigLoaded: boolean;
	isDeviceLoaded: boolean;
	registeredDeviceIdsKey: string;
	autoCollapseDisconnectedDevicesRef: React.RefObject<boolean>;
	commitRegisteredDevices: (recipe: (current: RegisteredDevice[]) => RegisteredDevice[]) => void;
}

export function useNotificationMonitors({
	isNotificationMonitorMode,
	isConfigLoaded,
	isDeviceLoaded,
	registeredDeviceIdsKey,
	autoCollapseDisconnectedDevicesRef,
	commitRegisteredDevices,
}: UseNotificationMonitorsOptions) {
	const activeNotificationMonitorsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (!isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		let isCancelled = false;

		const syncNotificationMonitors = async () => {
			const active = activeNotificationMonitorsRef.current;
			// Derive the desired set from the stable key so that this effect
			// does NOT re-run when battery levels or connection status change.
			const desiredIds = registeredDeviceIdsKey ? registeredDeviceIdsKey.split(',') : [];
			const desired = isNotificationMonitorMode
				? new Set(desiredIds)
				: new Set<string>();

			const idsToStop = [...active].filter(id => !desired.has(id));
			for (const id of idsToStop) {
				try {
					await stopBatteryNotificationMonitor(id);
				} catch (e) {
					logger.warn(`Failed to stop notification monitor for ${id}: ${String(e)}`);
				}
				active.delete(id);
			}

			if (!isNotificationMonitorMode) {
				await stopAllBatteryMonitors();
				return;
			}

			const monitorsToStart = [...desired].filter(id => !active.has(id));
			for (const id of monitorsToStart) {
				if (isCancelled) break;
				try {
					const info = await startBatteryNotificationMonitor(id);
					if (isCancelled) {
						await stopBatteryNotificationMonitor(id);
						continue;
					}
					active.add(id);
					const infoArray = Array.isArray(info) ? info : [info];
					// Empty array means the device was not connected at startup and a
					// connection watcher was launched. Keep isDisconnected:true until
					// the watcher emits a battery-info-notification event on connection.
					if (infoArray.length > 0) {
						commitRegisteredDevices(prev => prev.map(device => device.id === id
							? expandIfConnected(
								{ ...device, batteryInfos: mergeBatteryInfos(device.batteryInfos, infoArray), isDisconnected: false },
								autoCollapseDisconnectedDevicesRef.current,
							)
							: device
						));
					} else {
						commitRegisteredDevices(prev => prev.map(device => device.id === id
							? collapseIfDisconnected(
								{ ...device, isDisconnected: true },
								autoCollapseDisconnectedDevicesRef.current,
							)
							: device
						));
					}
				} catch {
					commitRegisteredDevices(prev => prev.map(device => {
						if (device.id !== id || device.isDisconnected) {
							return device;
						}
						return collapseIfDisconnected(
							{ ...device, isDisconnected: true },
							autoCollapseDisconnectedDevicesRef.current,
						);
					}));
				}
			}
		};

		fireAndForget(syncNotificationMonitors(), "Failed to synchronize battery notification monitors");

		return () => {
			isCancelled = true;
		};
	}, [
		registeredDeviceIdsKey,
		isNotificationMonitorMode,
		isConfigLoaded,
		isDeviceLoaded,
		autoCollapseDisconnectedDevicesRef,
		commitRegisteredDevices,
	]);

	useEffect(() => {
		const activeMonitors = activeNotificationMonitorsRef.current;
		return () => {
			const activeMonitorIds = [...activeMonitors.keys()];
			activeMonitors.clear();
			for (const id of activeMonitorIds) {
				fireAndForget(
					stopBatteryNotificationMonitor(id),
					`Failed to stop battery notification monitor for ${id}`,
				);
			}
		};
	}, []);

	return { activeNotificationMonitorsRef };
}
