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
import { useState, useEffect, useCallback, useRef } from "react";
import Button from "./components/Button";
import RegisteredDevicesPanel from "./components/RegisteredDevicesPanel";
import { logger } from "./utils/log";
import { moveWindowToTrayCenter, resizeWindowToContent } from "./utils/window";
import { PlusIcon, ArrowPathIcon, Cog8ToothIcon } from "@heroicons/react/24/outline";
import Modal from "./components/Modal";
import { useConfigContext } from "@/context/ConfigContext";
import { load, getStorePath } from '@/utils/storage';
import Settings from "@/components/Settings";
import { sendNotification } from "./utils/notification";
import { BatteryMonitorMode, NotificationType } from "./utils/config";
import { sleep } from "./utils/common";
import { platform } from "@tauri-apps/plugin-os";
import { useWindowEvents } from "@/hooks/useWindowEvents";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { emit, listen } from '@tauri-apps/api/event';

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
}

function upsertBatteryInfo(batteryInfos: BatteryInfo[], nextInfo: BatteryInfo): BatteryInfo[] {
	const key = nextInfo.user_descriptor ?? null;
	const idx = batteryInfos.findIndex(info => (info.user_descriptor ?? null) === key);
	if (idx === -1) {
		return [...batteryInfos, nextInfo];
	}
	const next = [...batteryInfos];
	next[idx] = nextInfo;
	return next;
}

const DEVICES_FILENAME = 'devices.json';

async function loadDevicesFromFile(): Promise<RegisteredDevice[]> {
	const storePath = await getStorePath(DEVICES_FILENAME);
	const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
	const devices = await deviceStore.get<RegisteredDevice[]>("devices");
	return devices || [];
}

function App() {
	const [registeredDevices, setRegisteredDevices] = useState<RegisteredDevice[]>([]);
	const [isDeviceLoaded, setIsDeviceLoaded] = useState(false);
	const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
	const [error, setError] = useState("");
	const { config, isConfigLoaded } = useConfigContext();
	const activeNotificationMonitorsRef = useRef<Set<string>>(new Set());

	const [state, setState] = useState<State>(State.main);
	const isPollingMode = config.batteryMonitorMode === BatteryMonitorMode.Polling;
	const isNotificationMonitorMode = !isPollingMode;

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

	// Load saved devices
	useEffect(() => {
		const fetchRegisteredDevices = async () => {
			const devices = await loadDevicesFromFile();
			setRegisteredDevices(devices.map(d => ({ ...d, isDisconnected: true })));
			logger.info(`Loaded saved registered devices: ${JSON.stringify(devices, null, 4)}`);
			setIsDeviceLoaded(true);
		};
		fetchRegisteredDevices();
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
		if (registeredDevices.some(d => d.id === id)) {
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
			if (isNotificationMonitorMode) {
				activeNotificationMonitorsRef.current.add(id);
			}
			const newDevice: RegisteredDevice = {
				id: device.id,
				name: device.name,
				batteryInfos: Array.isArray(info) ? info : [info],
				isDisconnected: false
			};
			setRegisteredDevices(prev => [...prev, newDevice]);
			handleCloseModal();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(`Failed to add device: ${msg}`);
			setState(State.addDeviceModal);
		}
	};

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
				setRegisteredDevices(prev => prev.map(d => d.id === device.id ? { ...d, batteryInfos: infoArray, isDisconnected: false } : d));

				if(isDisconnectedPrev && config.pushNotification && config.pushNotificationWhen[NotificationType.Connected]){
					await sendNotification(`${device.name} has been connected.`);
				}

				if(config.pushNotification && config.pushNotificationWhen[NotificationType.LowBattery]){
					const isLowBattery = mapIsLowBattery(infoArray);
					for(let i = 0; i < isLowBattery.length && i < isLowBatteryPrev.length; i++){
						if(!isLowBatteryPrev[i] && isLowBattery[i]){
							sendNotification(`${device.name}${
								infoArray.length >= 2 ?
									' ' + (infoArray[i].user_descriptor ?? 'Central')
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
					setRegisteredDevices(prev => prev.map(d => d.id === device.id ? { ...d, isDisconnected: true } : d));

					if(!isDisconnectedPrev && config.pushNotification && config.pushNotificationWhen[NotificationType.Disconnected]){
						await sendNotification(`${device.name} has been disconnected.`);
						return;
					}
				}
			}
			await sleep(500);
		}
	}, [config]);

	const handleCloseModal = () => {
		setState(State.main);
		setError("");
	};

	const handleOpenModal = async () => {
		setState(State.addDeviceModal);
		await fetchDevices();
	};

	const handleRemoveDevice = useCallback(async (device: RegisteredDevice) => {
		if (isNotificationMonitorMode) {
			try {
				await stopBatteryNotificationMonitor(device.id);
				activeNotificationMonitorsRef.current.delete(device.id);
			} catch (e) {
				logger.warn(`Failed to stop notification monitor for ${device.id}: ${String(e)}`);
			}
		}
		setRegisteredDevices(prev => prev.filter(d => d.id !== device.id));
	}, [isNotificationMonitorMode]);

	const handleReload = async () => {
		if (!isPollingMode) {
			return;
		}
		setState(State.fetchingBatteryInfo);
		await Promise.all(registeredDevices.map(updateBatteryInfo));
		setState(State.main);
	};

	// Handle window size change
	useEffect(() => {
		resizeWindowToContent().then(() => {
			if(isConfigLoaded && !config.manualWindowPositioning){
				moveWindowToTrayCenter();
				setTimeout(() => {
					moveWindowToTrayCenter();
				}, 50);
				setTimeout(() => {
					moveWindowToTrayCenter();
				}, 100);
			}
		});
	}, [registeredDevices, state, config.manualWindowPositioning, isConfigLoaded]);

	useEffect(() => {
		const unlistenPromise = listen<BatteryInfoNotificationEvent>("battery-info-notification", event => {
			const payload = event.payload;
			setRegisteredDevices(prev => prev.map(device => {
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
	}, []);

	useEffect(() => {
		const unlistenPromise = listen<BatteryMonitorStatusEvent>("battery-monitor-status", event => {
			const payload = event.payload;
			let notificationMessage: string | null = null;

			setRegisteredDevices(prev => prev.map(device => {
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
	}, [config.pushNotification, config.pushNotificationWhen]);

	useEffect(() => {
		if (!isConfigLoaded || !isDeviceLoaded) {
			return;
		}

		let isCancelled = false;

		const syncNotificationMonitors = async () => {
			const active = activeNotificationMonitorsRef.current;
			const desired = isNotificationMonitorMode
				? new Set(registeredDevices.map(device => device.id))
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
						setRegisteredDevices(prev => prev.map(device => device.id === id
							? { ...device, batteryInfos: infoArray, isDisconnected: false }
							: device
						));
					}
				} catch {
					setRegisteredDevices(prev => prev.map(device => {
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
		registeredDevices,
		isNotificationMonitorMode,
		isConfigLoaded,
		isDeviceLoaded,
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

	useEffect(() => {
		if (isDeviceLoaded) {
			const saveRegisteredDevices = async () => {
				const storePath = await getStorePath(DEVICES_FILENAME);
				const deviceStore = await load(storePath, { autoSave: true, defaults: {} });
				await deviceStore.set("devices", registeredDevices);
				logger.info('Saved registered devices');
			};
			saveRegisteredDevices();
		}

		// Update battery info periodically
		if (!isPollingMode) {
			return;
		}

		let isUnmounted = false;

		const interval = setInterval(() => {
			if(isUnmounted) return;
			Promise.all(registeredDevices.map(updateBatteryInfo));
		}, config.fetchInterval);

		return () => {
			isUnmounted = true;
			clearInterval(interval);
		};
	}, [registeredDevices, config.fetchInterval, isDeviceLoaded, updateBatteryInfo, isPollingMode]);

	return (
		<div id="app" className={`relative w-90 flex flex-col bg-background text-foreground rounded-lg p-2 ${
			state === State.main && registeredDevices.length > 0 ? '' :
			state === State.fetchingBatteryInfo ? 'min-h-58' :
			state === State.settings ? 'min-h-85' :
			'min-h-90'
		}`}>
			{state === State.settings ? (
				<Settings
					onExit={async () => { setState(State.main); }}
				/>
			) : (
				<>
					<div>
						{/* Drag area */}
						{ config.manualWindowPositioning && (
							<div data-tauri-drag-region className="fixed top-0 left-0 w-full h-14 bg-transparent z-0 cursor-grab active:cursor-grabbing"></div>
						)}

						{/* Top-right buttons */}
						<div className="flex flex-row ml-auto justify-end">
							{/* + button */}
							<Button
								className="w-10 h-10 rounded-lg bg-transparent flex items-center justify-center text-2xl !p-0 !px-0 !py-0 hover:bg-secondary relative z-10"
								onClick={handleOpenModal}
								aria-label="Add Device"
							>
								<PlusIcon className="size-5" />
							</Button>

							{/* Reload button */}
							<Button
								className="w-10 h-10 rounded-lg bg-transparent flex items-center justify-center text-2xl !p-0 text-foreground hover:bg-secondary disabled:!text-muted-foreground disabled:hover:bg-transparent relative z-10"
								onClick={handleReload}
								aria-label="Reload"
								disabled={registeredDevices.length === 0 || state === State.fetchingBatteryInfo || !isPollingMode}
							>
								<ArrowPathIcon className="size-5" />
							</Button>

							{/* Settings button */}
							<Button
								className="w-10 h-10 rounded-lg bg-transparent hover:bg-secondary flex items-center justify-center text-2xl !text-foreground !p-0 relative z-10"
								onClick={() => setState(State.settings)}
								aria-label="Settings"
							>
								<Cog8ToothIcon className="size-5" />
							</Button>
						</div>
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
									{devices.filter(d => !registeredDevices.some(rd => rd.id === d.id)).length === 0 && (
										<li className="text-muted-foreground">No devices found</li>
									)}
									{devices.filter(d => !registeredDevices.some(rd => rd.id === d.id)).map((d) => (
										<li key={d.id}>
											<Button
												className="w-full text-left rounded-none bg-card text-card-foreground hover:bg-muted transition-colors duration-300 !p-2"
												onClick={() => handleAddDevice(d.id)}
											>
												{d.name}
											</Button>
										</li>
									))}
								</ul>
							)}
						</Modal>
					)}

					{/* No devices registered */}
					{registeredDevices.length === 0 && (
						<div className="flex-1 flex flex-col items-center justify-center gap-6">
							<h1 className="text-2xl text-foreground">No devices registered</h1>
							<Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={handleOpenModal}>
								Add Device
							</Button>
						</div>
					)}

					{/* Devices registered */}
					{registeredDevices.length > 0 && (
						<main className="container mx-auto">
							<RegisteredDevicesPanel
								registeredDevices={registeredDevices}
								setRegisteredDevices={setRegisteredDevices}
								onRemoveDevice={handleRemoveDevice}
							/>
						</main>
					)}

					{/* Loading after device selection */}
					<Modal
						open={state === State.fetchingBatteryInfo}
						onClose={() => {}}
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
