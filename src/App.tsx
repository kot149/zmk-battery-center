import "./App.css";
import {
	listBatteryDevices,
	getBatteryInfo,
	startBatteryNotificationMonitor,
	stopBatteryNotificationMonitor,
	stopAllBatteryMonitors,
	BleDeviceInfo,
	BatteryInfo,
	BatteryInfoNotificationEvent,
	BatteryMonitorStatusEvent,
} from "./utils/ble";
import {
	useState,
	useEffect,
	useCallback,
	useRef,
	useMemo,
	type Dispatch,
	type SetStateAction,
} from "react";
import Button from "./components/Button";
import RegisteredDevicesPanel from "./components/RegisteredDevicesPanel";
import { logger } from "./utils/log";
import TopRightButtons from "./components/TopRightButtons";
import { moveWindowToTrayCenter, resizeWindowToContent } from "./utils/window";
import { PlusIcon, ArrowPathIcon, Cog8ToothIcon } from "@heroicons/react/24/outline";
import Modal from "./components/Modal";
import { useConfigContext } from "@/context/ConfigContext";
import { load, getStorePath } from '@/utils/storage';
import Settings from "@/components/Settings";
import { sendNotification } from "./utils/notification";
import { FETCH_INTERVAL_AUTO, NotificationType } from "./utils/config";
import { sleep } from "./utils/common";
import { platform } from "@tauri-apps/plugin-os";
import { useWindowEvents } from "@/hooks/useWindowEvents";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { emit, listen } from '@tauri-apps/api/event';
import { appendBatteryHistory } from '@/utils/batteryHistory';
import {
	upsertBatteryInfo,
	mergeBatteryInfos,
	normalizeLoadedDevices,
} from "@/utils/appHelpers";
import { syncTrayBatteryIcon } from "@/utils/trayBatteryIcon";

export type RegisteredDevice = {
	id: string;
	name: string;
	batteryInfos: BatteryInfo[];
	isDisconnected: boolean;
}

enum State {
	main = 'main',
	addDeviceModal = 'addDeviceModal',
	settings = 'settings',
	fetchingDevices = 'fetchingDevices',
	fetchingBatteryInfo = 'fetchingBatteryInfo',
	chart = 'chart',
}

const DEVICES_FILENAME = 'devices.json';

async function loadDevicesFromFile(): Promise<RegisteredDevice[]> {
	const storePath = await getStorePath(DEVICES_FILENAME);
	const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
	const raw = await deviceStore.get<unknown>("devices");
	const devices = normalizeLoadedDevices(raw);
	return devices;
}

const NOOP = () => {};

function App() {
	const [registeredDevices, setRegisteredDevices] = useState<
		RegisteredDevice[] | undefined
	>(undefined);
	const isDeviceLoaded = registeredDevices !== undefined;
	const deviceList = useMemo(
		() => registeredDevices ?? [],
		[registeredDevices],
	);
	const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
	const [error, setError] = useState("");
	const { config, isConfigLoaded } = useConfigContext();
	const activeNotificationMonitorsRef = useRef<Set<string>>(new Set());
	const registeredDevicesRef = useRef<RegisteredDevice[]>(deviceList);
	useEffect(() => {
		registeredDevicesRef.current = deviceList;
	}, [deviceList]);

	const persistRegisteredDevices = useCallback(async (devices: RegisteredDevice[]) => {
		const storePath = await getStorePath(DEVICES_FILENAME);
		const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
		await deviceStore.set("devices", devices);
		logger.info('Saved registered devices');
	}, []);

	const commitRegisteredDevices = useCallback(
		(recipe: (current: RegisteredDevice[]) => RegisteredDevice[]) => {
			setRegisteredDevices((prev) => {
				if (prev === undefined) {
					return prev;
				}
				const next = recipe(prev);
				void persistRegisteredDevices(next);
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

	const [state, setState] = useState<State>(State.main);
	const isPollingMode = config.fetchInterval !== FETCH_INTERVAL_AUTO;
	const isNotificationMonitorMode = !isPollingMode;

	const registeredDeviceIds = useMemo(
		() => new Set(deviceList.map(d => d.id)),
		[deviceList]
	);
	// Stable string key that changes only when the set of device IDs changes.
	// Used as a dependency for syncNotificationMonitors so that battery-level
	// or connection-status updates don't re-trigger the effect.
	const registeredDeviceIdsKey = useMemo(
		() => [...registeredDeviceIds].sort().join(','),
		[registeredDeviceIds]
	);
	const availableDevices = useMemo(
		() => devices.filter(d => !registeredDeviceIds.has(d.id)),
		[devices, registeredDeviceIds]
	);

	// Initialize window and tray event listeners
	const handleWindowPositionChange = useCallback((position: { x: number; y: number }) => {
		emit('update-config', { windowPosition: position });
	}, []);

	const handleManualWindowPositioningChange = useCallback((enabled: boolean) => {
		emit('update-config', { manualWindowPositioning: enabled });
	}, []);

	useWindowEvents({
		config,
		isConfigLoaded,
		onWindowPositionChange: handleWindowPositionChange,
	});

	useTrayEvents({
		config,
		isConfigLoaded,
		onManualWindowPositioningChange: handleManualWindowPositioningChange,
	});

	useEffect(() => {
		if (registeredDevices === undefined) return;
		if (!isConfigLoaded) return;
		if (platform() !== "macos") return;
		const id = window.setTimeout(() => {
			void syncTrayBatteryIcon(registeredDevices, config.trayIconComponents);
		}, 60);
		return () => clearTimeout(id);
	}, [registeredDevices, config.trayIconComponents, isConfigLoaded]);

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
		void fetchRegisteredDevices();
		return () => {
			cancelled = true;
		};
	}, []);

	async function fetchDevices() {
		setState(State.fetchingDevices);
		setError("");
		let timeoutId: number | null = null;
		let finished = false;

		const isMac = platform() === 'macos';

		try {
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = window.setTimeout(() => {
					finished = true;
					let msg = "Failed to fetch devices.";
					if (isMac) {
						msg += " If you are using macOS, please make sure Bluetooth permission is granted.";
					}
					setError(msg);
					setState(State.addDeviceModal);
					reject(new Error(msg));
				}, 20000);
			});
			const result = await Promise.race([
				listBatteryDevices(),
				timeoutPromise
			]);
			if (!finished) {
				setDevices(result as BleDeviceInfo[]);
				setState(State.addDeviceModal);
			}
		} catch (e: unknown) {
			if (!finished) {
				let msg = e instanceof Error ? e.message : String(e);
				if (isMac && !msg.includes("Bluetooth permission")) {
					msg += " If you are using macOS, please make sure Bluetooth permission is granted.";
				}
				setError(msg);
				setState(State.addDeviceModal);
			}
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	}

	const mapIsLowBattery = (batteryInfos: BatteryInfo[]) => {
		return batteryInfos.map(info => info.battery_level !== null ? info.battery_level <= 20 : false);
	}

	const handleAddDevice = async (id: string) => {
		if (!isDeviceLoaded) {
			return;
		}
		if (registeredDeviceIds.has(id)) {
			handleCloseModal();
			return;
		}

		const device = devices.find(d => d.id === id);
		if (!device) return;

		setState(State.fetchingBatteryInfo);
		setError("");
		try {
			const info = isNotificationMonitorMode
				? await startBatteryNotificationMonitor(id)
				: await getBatteryInfo(id);
			const infoArray = Array.isArray(info) ? info : [info];
			if (isNotificationMonitorMode) {
				activeNotificationMonitorsRef.current.add(id);
			}
			const newDevice: RegisteredDevice = {
				id: device.id,
				name: device.name,
				batteryInfos: infoArray,
				isDisconnected: isNotificationMonitorMode ? infoArray.length === 0 : false,
			};
			commitRegisteredDevices(prev => [...prev, newDevice]);
			handleCloseModal();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(`Failed to add device: ${msg}`);
			setState(State.addDeviceModal);
		}
	};

	const pushNotificationRef = useRef(config.pushNotification);
	const pushNotificationWhenRef = useRef(config.pushNotificationWhen);
	useEffect(() => {
		pushNotificationRef.current = config.pushNotification;
		pushNotificationWhenRef.current = config.pushNotificationWhen;
	}, [config.pushNotification, config.pushNotificationWhen]);

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
					return { ...d, batteryInfos: mergeBatteryInfos(d.batteryInfos, infoArray), isDisconnected: false };
				}));

				// Record battery history
				for (const info of infoArray) {
					if (info.battery_level !== null) {
						appendBatteryHistory(
							device.name,
							device.id,
							info.user_description ?? 'Central',
							info.battery_level,
						).then(() => {
							void emit('battery-history-updated', { deviceId: device.id });
						});
					}
				}

				if(isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Connected]){
					await sendNotification(`${device.name} has been connected.`);
				}

				if(pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.LowBattery]){
					const isLowBattery = mapIsLowBattery(infoArray);
					for(let i = 0; i < isLowBattery.length && i < isLowBatteryPrev.length; i++){
						if(!isLowBatteryPrev[i] && isLowBattery[i]){
							sendNotification(`${device.name}${
								infoArray.length >= 2 ?
									' ' + (infoArray[i].user_description ?? 'Central')
									: ''
							} has low battery.`);
							logger.info(`${device.name} has low battery.`);
						}
					}
				}

				return;
			} catch {
				attempts++;
				if (attempts >= maxAttempts) {
					commitRegisteredDevices(prev => prev.map(d => d.id === device.id ? { ...d, isDisconnected: true } : d));

					if(!isDisconnectedPrev && pushNotificationRef.current && pushNotificationWhenRef.current[NotificationType.Disconnected]){
						await sendNotification(`${device.name} has been disconnected.`);
						return;
					}
				}
			}
			await sleep(500);
		}
	}, [commitRegisteredDevices]);

	const handleCloseModal = () => {
		setState(State.main);
		setError("");
	};

	const handleOpenModal = async () => {
		if (!isDeviceLoaded) {
			return;
		}
		setState(State.addDeviceModal);
		await fetchDevices();
	};

	const handleRemoveDevice = useCallback(async (device: RegisteredDevice) => {
		commitRegisteredDevices(prev => prev.filter(d => d.id !== device.id));
		if (!isNotificationMonitorMode) {
			return;
		}
		try {
			await stopBatteryNotificationMonitor(device.id);
		} catch (e) {
			logger.warn(`Failed to stop notification monitor for ${device.id}: ${String(e)}`);
		} finally {
			activeNotificationMonitorsRef.current.delete(device.id);
		}
	}, [isNotificationMonitorMode, commitRegisteredDevices]);

	const handleReload = async () => {
		if (!isPollingMode) {
			return;
		}
		if (!isDeviceLoaded) {
			return;
		}
		setState(State.fetchingBatteryInfo);
		await Promise.all(deviceList.map(updateBatteryInfo));
		setState(State.main);
	};

	// Handle window size change
	useEffect(() => {
		resizeWindowToContent().then(() => {
			if (isConfigLoaded && !config.manualWindowPositioning) {
				moveWindowToTrayCenter();
				setTimeout(() => {
					moveWindowToTrayCenter();
				}, 50);
				setTimeout(() => {
					moveWindowToTrayCenter();
				}, 100);
			}
		});
	}, [deviceList, state, config.manualWindowPositioning, isConfigLoaded]);

	useEffect(() => {
		if (!isDeviceLoaded) {
			return;
		}
		const unlistenPromise = listen<BatteryInfoNotificationEvent>("battery-info-notification", event => {
			const payload = event.payload;
			// Record battery history for notification-mode updates
			if (payload.battery_info.battery_level !== null) {
				const device = registeredDevicesRef.current.find(d => d.id === payload.id);
				if (device) {
					appendBatteryHistory(
						device.name,
						device.id,
						payload.battery_info.user_description ?? 'Central',
						payload.battery_info.battery_level,
					).then(() => {
						void emit('battery-history-updated', { deviceId: payload.id });
					});
				}
			}
			commitRegisteredDevices(prev => prev.map(device => {
				if (device.id !== payload.id) {
					return device;
				}
				return {
					...device,
					batteryInfos: upsertBatteryInfo(device.batteryInfos, payload.battery_info),
					isDisconnected: false,
				};
			}));
		});

		return () => {
			unlistenPromise.then(unlisten => unlisten());
		};
	}, [isDeviceLoaded, commitRegisteredDevices]);

	useEffect(() => {
		if (!isDeviceLoaded) {
			return;
		}
		const unlistenPromise = listen<BatteryMonitorStatusEvent>("battery-monitor-status", event => {
			const payload = event.payload;
			let notificationMessage: string | null = null;

			commitRegisteredDevices(prev => prev.map(device => {
				if (device.id !== payload.id) {
					return device;
				}

				const nextDisconnected = !payload.connected;
				if (device.isDisconnected === nextDisconnected) {
					return device;
				}

				if (payload.connected) {
					if (config.pushNotification && config.pushNotificationWhen[NotificationType.Connected]) {
						notificationMessage = `${device.name} has been connected.`;
					}
				} else if (config.pushNotification && config.pushNotificationWhen[NotificationType.Disconnected]) {
					notificationMessage = `${device.name} has been disconnected.`;
				}

				return { ...device, isDisconnected: nextDisconnected };
			}));

			if (notificationMessage) {
				void sendNotification(notificationMessage);
			}
		});

		return () => {
			unlistenPromise.then(unlisten => unlisten());
		};
	}, [isDeviceLoaded, config.pushNotification, config.pushNotificationWhen, commitRegisteredDevices]);

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
							? { ...device, batteryInfos: mergeBatteryInfos(device.batteryInfos, infoArray), isDisconnected: false }
							: device
						));
					}
				} catch {
					commitRegisteredDevices(prev => prev.map(device => {
						if (device.id !== id || device.isDisconnected) {
							return device;
						}
						return { ...device, isDisconnected: true };
					}));
				}
			}
		};

		syncNotificationMonitors();

		return () => {
			isCancelled = true;
		};
	}, [
		registeredDeviceIdsKey,
		isNotificationMonitorMode,
		isConfigLoaded,
		isDeviceLoaded,
		commitRegisteredDevices,
	]);

	useEffect(() => {
		const activeMonitors = activeNotificationMonitorsRef.current;
		return () => {
			const activeMonitorIds = [...activeMonitors.keys()];
			activeMonitors.clear();
			for (const id of activeMonitorIds) {
				void stopBatteryNotificationMonitor(id);
			}
		};
	}, []);

	// Polling: use registeredDevicesRef so this effect doesn't re-run on every
	// device update (which would cause an infinite loop).
	useEffect(() => {
		if (!isPollingMode || !isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		let isUnmounted = false;

		// Run the first poll immediately without waiting for the interval
		Promise.all(registeredDevicesRef.current.map(updateBatteryInfo));

		const interval = setInterval(() => {
			if (isUnmounted) return;
			Promise.all(registeredDevicesRef.current.map(updateBatteryInfo));
		}, config.fetchInterval as number);

		return () => {
			isUnmounted = true;
			clearInterval(interval);
		};
	}, [isPollingMode, isConfigLoaded, isDeviceLoaded, config.fetchInterval, updateBatteryInfo]);

	const handleExitSettings = useCallback(async () => {
		setState(State.main);
	}, []);

	const handleOpenSettings = useCallback(() => {
		setState(State.settings);
	}, []);

	const handleChartOpenChange = useCallback((isOpen: boolean) => {
		setState(isOpen ? State.chart : State.main);
	}, []);

	return (
		<div id="app" className={`relative flex flex-col bg-background text-foreground rounded-lg p-2 ${
			state === State.main && deviceList.length > 0 ? 'w-90' :
			state === State.chart ? 'w-110 h-90' :
			state === State.fetchingBatteryInfo ? 'w-90 min-h-58' :
			state === State.settings ? 'w-90 min-h-85' :
			'w-90 min-h-90'
		}`}>
			{state === State.settings ? (
				<Settings
					onExit={handleExitSettings}
				/>
			) : (
				<>
					<div>
						{/* Drag area */}
						{ config.manualWindowPositioning && (
							<div data-tauri-drag-region className="fixed top-0 left-0 w-full h-14 bg-transparent z-0 cursor-grab active:cursor-grabbing"></div>
						)}

						{/* Top-right buttons */}
						<TopRightButtons
							buttons={[
								{
									icon: <PlusIcon className="size-5" />,
									onClick: handleOpenModal,
									ariaLabel: "Add Device",
									disabled: !isDeviceLoaded,
								},
								{
									icon: <ArrowPathIcon className="size-5" />,
									onClick: handleReload,
									ariaLabel: "Reload",
									disabled: deviceList.length === 0 || state === State.fetchingBatteryInfo || !isPollingMode,
								},
								{
									icon: <Cog8ToothIcon className="size-5" />,
									onClick: handleOpenSettings,
									ariaLabel: "Settings",
								}
							]}
						/>
					</div>

					{/* Modal (device selection) */}
					{(state === State.addDeviceModal || state === State.fetchingDevices) && (
						<Modal
							open={true}
							onClose={handleCloseModal}
							title="Select Device"
							isLoading={state === State.fetchingDevices}
							error={error}
							loadingText="Fetching devices..."
						>
							{state === State.addDeviceModal && (
								<ul className="max-h-60 overflow-y-auto rounded-sm">
									{availableDevices.length === 0 ? (
										<li className="text-muted-foreground">No devices found</li>
									) : (
										availableDevices.map((d) => (
											<li key={d.id}>
												<Button
													className="w-full text-left rounded-none bg-card text-card-foreground hover:bg-muted transition-colors duration-300 p-2!"
													onClick={() => handleAddDevice(d.id)}
												>
													{d.name}
												</Button>
											</li>
										))
									)}
								</ul>
							)}
						</Modal>
					)}

					{/* Devices content */}
					{deviceList.length > 0 ? (
						<main className="container mx-auto">
							<RegisteredDevicesPanel
								registeredDevices={deviceList}
								setRegisteredDevices={setRegisteredDevicesForPanel}
								onRemoveDevice={handleRemoveDevice}
								onChartOpenChange={handleChartOpenChange}
							/>
						</main>
					) : (
						<div className="flex-1 flex flex-col items-center justify-center gap-6">
							<h1 className="text-2xl text-foreground">No devices registered</h1>
							<Button
								className="bg-primary text-primary-foreground hover:bg-primary/90"
								onClick={handleOpenModal}
								disabled={!isDeviceLoaded}
							>
								Add Device
							</Button>
						</div>
					)}

					{/* Loading after device selection */}
					<Modal
						open={state === State.fetchingBatteryInfo}
						onClose={NOOP}
						isLoading={true}
						loadingText="Fetching battery info..."
						showCloseButton={false}
					/>
				</>
			)}
		</div>
	);
}

export default App;

export { upsertBatteryInfo, mergeBatteryInfos, normalizeLoadedDevices };
