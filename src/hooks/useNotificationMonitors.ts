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
	const syncGenerationRef = useRef(0);
	const syncChainRef = useRef<Promise<void>>(Promise.resolve());

	useEffect(() => {
		if (!isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		const generation = ++syncGenerationRef.current;
		const isStale = () => syncGenerationRef.current !== generation;

		const syncNotificationMonitors = async () => {
			if (isStale()) return; // superseded while queued behind the previous run
			const active = activeNotificationMonitorsRef.current;
			// Derive the desired set from the stable key so that this effect
			// does NOT re-run when battery levels or connection status change.
			const desiredIds = registeredDeviceIdsKey ? registeredDeviceIdsKey.split(',') : [];
			const desired = isNotificationMonitorMode
				? new Set(desiredIds)
				: new Set<string>();

			const idsToStop = [...active].filter(id => !desired.has(id));
			for (const id of idsToStop) {
				if (isStale()) break;
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
				if (isStale()) break;
				try {
					const info = await startBatteryNotificationMonitor(id);
					// The monitor IS running now; `active` must say so even if this
					// run was superseded — the next run reconciles from true state.
					active.add(id);
					if (isStale()) return;
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

		syncChainRef.current = syncChainRef.current
			.then(syncNotificationMonitors)
			.catch(e => logger.warn(`Failed to synchronize battery notification monitors: ${String(e)}`));

		return () => {
			// Bump the generation so an in-flight run stops mutating state.
			// (A newer effect run bumps it anyway; this covers unmount.)
			syncGenerationRef.current++; // eslint-disable-line react-hooks/exhaustive-deps -- plain counter ref, not a DOM node
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
