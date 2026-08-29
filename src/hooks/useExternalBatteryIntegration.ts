import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { fireAndForget } from "@/utils/common";
import { logger } from "@/utils/log";
import {
	buildExternalBatteryDevices,
	buildRunCatProjection,
	completeExternalBatteryRefresh,
	getPendingExternalBatteryRefresh,
	publishExternalBatterySnapshot,
	type BatteryRefreshDeviceResult,
	type ExternalRefreshRequest,
	type RegisteredDevicesSnapshot,
} from "@/utils/externalBatteryIntegration";
import type { RegisteredDevice } from "@/utils/appHelpers";

const PUBLISH_DEBOUNCE_MS = 75;
const FRONTEND_REFRESH_TIMEOUT_MS = 60_000;

type UseExternalBatteryIntegrationOptions = {
	isDeviceLoaded: boolean;
	registeredDevices: RegisteredDevice[] | undefined;
	getRegisteredDevicesSnapshot: () => RegisteredDevicesSnapshot;
	isPollingMode: boolean;
	refreshAllForExternal: () => Promise<BatteryRefreshDeviceResult[]>;
	refreshAllNotificationMonitors: () => Promise<BatteryRefreshDeviceResult[]>;
};

function unavailableResults(devices: RegisteredDevice[]): BatteryRefreshDeviceResult[] {
	return devices.map(device => ({ id: device.id, status: "unavailable" }));
}

function normalizeResults(
	devices: RegisteredDevice[],
	results: BatteryRefreshDeviceResult[],
): BatteryRefreshDeviceResult[] {
	const byId = new Map(results.map(result => [result.id, result]));
	return devices.map(device => byId.get(device.id) ?? { id: device.id, status: "unavailable" });
}

export function useExternalBatteryIntegration({
	isDeviceLoaded,
	registeredDevices,
	getRegisteredDevicesSnapshot,
	isPollingMode,
	refreshAllForExternal,
	refreshAllNotificationMonitors,
}: UseExternalBatteryIntegrationOptions) {
	const getSnapshotRef = useRef(getRegisteredDevicesSnapshot);
	const isDeviceLoadedRef = useRef(isDeviceLoaded);
	const isPollingModeRef = useRef(isPollingMode);
	const refreshAllForExternalRef = useRef(refreshAllForExternal);
	const refreshAllNotificationMonitorsRef = useRef(refreshAllNotificationMonitors);
	const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestQueueRef = useRef<ExternalRefreshRequest[]>([]);
	const activeRequestIdsRef = useRef(new Set<string>());
	const terminalRequestIdsRef = useRef(new Set<string>());
	const processingRequestRef = useRef(false);

	getSnapshotRef.current = getRegisteredDevicesSnapshot;
	isDeviceLoadedRef.current = isDeviceLoaded;
	isPollingModeRef.current = isPollingMode;
	refreshAllForExternalRef.current = refreshAllForExternal;
	refreshAllNotificationMonitorsRef.current = refreshAllNotificationMonitors;

	const publishSnapshot = useCallback(() => {
		if (!isDeviceLoadedRef.current) return;
		const snapshot = getSnapshotRef.current();
		const devices = buildExternalBatteryDevices(snapshot.devices);
		const runCatProjection = buildRunCatProjection(snapshot.devices);
		fireAndForget(
			publishExternalBatterySnapshot(snapshot.sourceRevision, devices, runCatProjection),
			"Failed to publish external battery snapshot",
		);
	}, []);

	useEffect(() => {
		if (!isDeviceLoaded) return;
		if (publishTimerRef.current !== null) {
			clearTimeout(publishTimerRef.current);
		}
		publishTimerRef.current = setTimeout(() => {
			publishTimerRef.current = null;
			publishSnapshot();
		}, PUBLISH_DEBOUNCE_MS);
		return () => {
			if (publishTimerRef.current !== null) {
				clearTimeout(publishTimerRef.current);
				publishTimerRef.current = null;
			}
		};
	}, [isDeviceLoaded, registeredDevices, publishSnapshot]);

	const processRequest = useCallback(async (request: ExternalRefreshRequest) => {
		await new Promise<void>((resolve) => {
			let finished = false;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const finish = (results: BatteryRefreshDeviceResult[]) => {
				if (finished) return;
				finished = true;
				if (timeoutId !== null) clearTimeout(timeoutId);
				const snapshot = getSnapshotRef.current();
				const normalized = normalizeResults(snapshot.devices, results);
				const complete = async () => {
					try {
						await completeExternalBatteryRefresh(
							request.requestId,
							snapshot.sourceRevision,
							normalized,
							buildExternalBatteryDevices(snapshot.devices),
							buildRunCatProjection(snapshot.devices),
						);
						terminalRequestIdsRef.current.add(request.requestId);
						activeRequestIdsRef.current.delete(request.requestId);
					} catch (error) {
						logger.warn(`Failed to complete external battery refresh ${request.requestId}: ${String(error)}`);
					} finally {
						resolve();
					}
				};
				void complete();
			};

			let refreshPromise: Promise<BatteryRefreshDeviceResult[]>;
			try {
				if (!isDeviceLoadedRef.current) {
					refreshPromise = Promise.resolve(unavailableResults([]));
				} else {
					const devices = getSnapshotRef.current().devices;
					refreshPromise = devices.length === 0
						? Promise.resolve([])
						: isPollingModeRef.current
							? refreshAllForExternalRef.current()
							: refreshAllNotificationMonitorsRef.current();
				}
			} catch (error) {
				logger.warn(`External battery refresh failed for ${request.requestId}: ${String(error)}`);
				finish(unavailableResults(getSnapshotRef.current().devices));
				return;
			}

			timeoutId = setTimeout(() => {
				finish(unavailableResults(getSnapshotRef.current().devices));
			}, FRONTEND_REFRESH_TIMEOUT_MS);
			Promise.resolve(refreshPromise)
				.then(finish)
				.catch(error => {
					logger.warn(`External battery refresh failed for ${request.requestId}: ${String(error)}`);
					finish(unavailableResults(getSnapshotRef.current().devices));
				});
		});
	}, []);

	const drainRequests = useCallback(async () => {
		if (processingRequestRef.current || !isDeviceLoadedRef.current) return;
		processingRequestRef.current = true;
		try {
			while (requestQueueRef.current.length > 0 && isDeviceLoadedRef.current) {
				const request = requestQueueRef.current.shift();
				if (!request) continue;
				if (terminalRequestIdsRef.current.has(request.requestId)) continue;
				activeRequestIdsRef.current.add(request.requestId);
				await processRequest(request);
			}
		} finally {
			processingRequestRef.current = false;
		}
	}, [processRequest]);

	const queueRequest = useCallback((request: ExternalRefreshRequest) => {
		if (activeRequestIdsRef.current.has(request.requestId)
			|| terminalRequestIdsRef.current.has(request.requestId)
			|| requestQueueRef.current.some(item => item.requestId === request.requestId)) {
			return;
		}
		requestQueueRef.current.push(request);
		fireAndForget(drainRequests(), "Failed to process external battery refresh request");
	}, [drainRequests]);

	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | null = null;
		const setup = async () => {
			try {
				const listener = await listen<ExternalRefreshRequest>("external-battery-refresh-requested", event => {
					if (!cancelled) queueRequest(event.payload);
				});
				if (cancelled) {
					listener();
					return;
				}
				unlisten = listener;
				const pending = await getPendingExternalBatteryRefresh();
				if (!cancelled && pending) queueRequest(pending);
			} catch (error) {
				logger.warn(`Failed to initialize external battery refresh listener: ${String(error)}`);
			}
		};
		void setup();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [queueRequest]);

	useEffect(() => {
		if (isDeviceLoaded) {
			fireAndForget(drainRequests(), "Failed to drain external battery refresh requests");
		}
	}, [isDeviceLoaded, drainRequests]);

	useEffect(() => () => {
		if (publishTimerRef.current !== null) {
			clearTimeout(publishTimerRef.current);
		}
	}, []);
}
