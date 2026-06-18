import {
	useState,
	useEffect,
	useCallback,
	useRef,
	useMemo,
	type Dispatch,
	type SetStateAction,
} from "react";
import { logger } from "@/utils/log";
import { load, getStorePath } from "@/utils/storage";
import { fireAndForget } from "@/utils/common";
import {
	normalizeLoadedDevices,
	type RegisteredDevice,
} from "@/utils/appHelpers";

const DEVICES_FILENAME = "devices.json";

async function loadDevicesFromFile(): Promise<RegisteredDevice[]> {
	const storePath = await getStorePath(DEVICES_FILENAME);
	const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
	const raw = await deviceStore.get<unknown>("devices");
	const devices = normalizeLoadedDevices(raw);
	return devices;
}

export function collapseIfDisconnected(device: RegisteredDevice, shouldCollapse: boolean): RegisteredDevice {
	if (!shouldCollapse || !device.isDisconnected || device.isCollapsed) {
		return device;
	}
	return { ...device, isCollapsed: true };
}

export function expandIfConnected(device: RegisteredDevice, shouldExpand: boolean): RegisteredDevice {
	if (!shouldExpand || device.isDisconnected || !device.isCollapsed) {
		return device;
	}
	return { ...device, isCollapsed: false };
}

export function useRegisteredDevices() {
	const [registeredDevices, setRegisteredDevices] = useState<RegisteredDevice[] | undefined>(undefined);
	const isDeviceLoaded = registeredDevices !== undefined;
	const deviceList = useMemo(
		() => registeredDevices ?? [],
		[registeredDevices],
	);
	const registeredDevicesRef = useRef<RegisteredDevice[]>(deviceList);
	useEffect(() => {
		registeredDevicesRef.current = deviceList;
	}, [deviceList]);

	const persistRegisteredDevices = useCallback(async (devices: RegisteredDevice[]) => {
		const storePath = await getStorePath(DEVICES_FILENAME);
		const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
		await deviceStore.set("devices", devices);
		logger.info("Saved registered devices");
	}, []);

	const commitRegisteredDevices = useCallback(
		(recipe: (current: RegisteredDevice[]) => RegisteredDevice[]) => {
			setRegisteredDevices((prev) => {
				if (prev === undefined) {
					return prev;
				}
				const next = recipe(prev);
				fireAndForget(persistRegisteredDevices(next), "Failed to persist registered devices");
				return next;
			});
		},
		[persistRegisteredDevices],
	);

	const setRegisteredDevicesForPanel = useCallback<
		Dispatch<SetStateAction<RegisteredDevice[]>>
	>(
		(action) => {
			commitRegisteredDevices((prev) =>
				typeof action === "function"
					? (action as (p: RegisteredDevice[]) => RegisteredDevice[])(prev)
					: action,
			);
		},
		[commitRegisteredDevices],
	);

	const registeredDeviceIds = useMemo(
		() => new Set(deviceList.map(d => d.id)),
		[deviceList]
	);
	// Stable string key that changes only when the set of device IDs changes.
	// Used as a dependency for syncNotificationMonitors so that battery-level
	// or connection-status updates don't re-trigger the effect.
	const registeredDeviceIdsKey = useMemo(
		() => [...registeredDeviceIds].sort().join(","),
		[registeredDeviceIds]
	);

	// Load saved devices
	useEffect(() => {
		let cancelled = false;
		const fetchRegisteredDevices = async () => {
			const devices = await loadDevicesFromFile();
			if (cancelled) {
				return;
			}
			setRegisteredDevices((prev) => {
				// Avoid overwriting user-visible state (e.g. after remove) when a
				// slower load completes — common with StrictMode double-mount or
				// store I/O contending with notification-mode persistence.
				if (prev !== undefined) {
					return prev;
				}
				return devices.map(d => ({ ...d, isDisconnected: true }));
			});
			logger.info(`Loaded saved registered devices: ${JSON.stringify(devices, null, 4)}`);
		};
		fireAndForget(fetchRegisteredDevices(), "Failed to load registered devices");
		return () => {
			cancelled = true;
		};
	}, []);

	return {
		registeredDevices,
		isDeviceLoaded,
		deviceList,
		registeredDevicesRef,
		registeredDeviceIds,
		registeredDeviceIdsKey,
		commitRegisteredDevices,
		setRegisteredDevicesForPanel,
	};
}
