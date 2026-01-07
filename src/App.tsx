import "./App.css";
import { listBatteryDevices, getBatteryInfo, BleDeviceInfo, BatteryInfo } from "./utils/ble";
import { useState, useEffect, useCallback } from "react";
import { mockRegisteredDevices } from "./utils/mockData";
import Button from "./components/Button";
import RegisteredDevicesPanel from "./components/RegisteredDevicesPanel";
import { logger } from "./utils/log";
import { moveWindowToTrayCenter, resizeWindowToContent } from "./utils/window";
import { PlusIcon, ArrowPathIcon, Cog8ToothIcon } from "@heroicons/react/24/outline";
import Modal from "./components/Modal";
import { useConfigContext } from "@/context/ConfigContext";
import { load } from '@tauri-apps/plugin-store';
import Settings from "@/components/Settings";
import { sendNotification } from "./utils/notification";
import { NotificationType } from "./utils/config";
import { sleep } from "./utils/common";
import { platform } from "@tauri-apps/plugin-os";
import { useWindowEvents } from "@/hooks/useWindowEvents";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { emit } from '@tauri-apps/api/event';

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

// Debug mode
const IS_DEV = process.env.NODE_ENV === 'development';

function App() {
	const [isDebugMode, setIsDebugMode] = useState(false);
	const [registeredDevices, setRegisteredDevices] = useState<RegisteredDevice[]>(isDebugMode ? mockRegisteredDevices : []);
	const [isDeviceLoaded, setIsDeviceLoaded] = useState(false);

	const toggleDebugMode = () => {
		setIsDebugMode(prev => {
			if (!prev) {
				setRegisteredDevices(mockRegisteredDevices);
			} else {
				setRegisteredDevices([]);
			}
			return !prev;
		});
	};

	const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
	const [error, setError] = useState("");
	const { config, isConfigLoaded } = useConfigContext();

	const [state, setState] = useState<State>(State.main);

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
			const deviceStore = await load('devices.json', { autoSave: true, defaults: {} });
			const devices = await deviceStore.get<RegisteredDevice[]>("devices");
			setRegisteredDevices(devices || []);
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
		if (!registeredDevices.some(d => d.id === id)) {
			const device = devices.find(d => d.id === id);
			if (!device) return;
			setState(State.fetchingBatteryInfo);
			const info = await getBatteryInfo(id);
			const newDevice: RegisteredDevice = {
				id: device.id,
				name: device.name,
				batteryInfos: Array.isArray(info) ? info : [info],
				isDisconnected: false
			};
			setRegisteredDevices(prev => [...prev, newDevice]);
		}
		handleCloseModal();
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
									' ' + (infoArray[i].user_descriptor ?? 'Central') + ' '
									: ''
							}has low battery.`);
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

	const handleReload = async () => {
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
		// Save registered devices
		if(isDeviceLoaded){
			const saveRegisteredDevices = async () => {
				const deviceStore = await load('devices.json', { autoSave: true, defaults: {} });
				await deviceStore.set("devices", registeredDevices);
				logger.info('Saved registered devices');
			};
			saveRegisteredDevices();
		}

		// Update battery info periodically
		let isUnmounted = false;

		const interval = setInterval(() => {
			if(isUnmounted) return;
			registeredDevices.forEach(updateBatteryInfo);
		}, config.fetchInterval);

		return () => {
			isUnmounted = true;
			clearInterval(interval);
		};
	}, [registeredDevices, config.fetchInterval, isDeviceLoaded, updateBatteryInfo]);

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

						{/* Debug mode toggle button */}
						{IS_DEV && (
							<div className="fixed top-4 left-4">
								<button
									className={`px-3 py-1 rounded-lg text-sm ${isDebugMode ? 'bg-yellow-600' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted'} hover:opacity-80 transition duration-200`}
									onClick={toggleDebugMode}
								>
									{isDebugMode ? 'Debug Mode' : 'Production Mode'}
								</button>
							</div>
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
								disabled={registeredDevices.length === 0 || state === State.fetchingBatteryInfo}
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
