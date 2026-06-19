import "./App.css";
import {
	listBatteryDevices,
	getBatteryInfo,
	startBatteryNotificationMonitor,
	stopBatteryNotificationMonitor,
	BleDeviceInfo,
	BatteryInfoNotificationEvent,
	BatteryMonitorStatusEvent,
} from "./utils/ble";
import {
	useState,
	useEffect,
	useCallback,
	useRef,
	useMemo,
} from "react";
import Button from "./components/Button";
import RegisteredDevicesPanel from "./components/RegisteredDevicesPanel";
import { logger } from "./utils/log";
import TopRightButtons from "./components/TopRightButtons";
import { moveWindowToTrayCenter, resizeWindowToContent } from "./utils/window";
import { PlusIcon, ArrowPathIcon, Cog8ToothIcon } from "@heroicons/react/24/outline";
import Modal from "./components/Modal";
import { useConfigContext } from "@/context/ConfigContext";
import Settings from "@/components/Settings";
import { sendNotification } from "./utils/notification";
import { FETCH_INTERVAL_AUTO, NotificationType } from "./utils/config";
import { fireAndForget, withTimeout } from "./utils/common";
import { platform } from "@tauri-apps/plugin-os";
import { useWindowEvents } from "@/hooks/useWindowEvents";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { emit, listen } from '@tauri-apps/api/event';
import { appendBatteryHistory } from '@/utils/batteryHistory';
import {
	upsertBatteryInfo,
	getRegisteredDeviceDisplayName,
	type RegisteredDevice,
} from "@/utils/appHelpers";
import { syncTrayBatteryIcon } from "@/utils/trayBatteryIcon";
import { useRegisteredDevices, collapseIfDisconnected, expandIfConnected } from "@/hooks/useRegisteredDevices";
import { useNotificationMonitors } from "@/hooks/useNotificationMonitors";
import { useBatteryPolling } from "@/hooks/useBatteryPolling";

export type { RegisteredDevice };

enum State {
	main = 'main',
	addDeviceModal = 'addDeviceModal',
	settings = 'settings',
	fetchingDevices = 'fetchingDevices',
	fetchingBatteryInfo = 'fetchingBatteryInfo',
	chart = 'chart',
}

const DEVICE_FETCH_TIMEOUT_MS = 20_000;

const NOOP = () => {};

function App() {
	const {
		registeredDevices,
		isDeviceLoaded,
		deviceList,
		registeredDevicesRef,
		registeredDeviceIds,
		registeredDeviceIdsKey,
		commitRegisteredDevices,
		setRegisteredDevicesForPanel,
	} = useRegisteredDevices();

	const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
	const [error, setError] = useState("");
	const { config, isConfigLoaded } = useConfigContext();

	const [state, setState] = useState<State>(State.main);
	const [panelLayoutRevision, setPanelLayoutRevision] = useState(0);
	const isPollingMode = config.fetchInterval !== FETCH_INTERVAL_AUTO;
	const isNotificationMonitorMode = !isPollingMode;

	const availableDevices = useMemo(
		() => devices.filter(d => !registeredDeviceIds.has(d.id)),
		[devices, registeredDeviceIds]
	);

	// Initialize window and tray event listeners
	const handleWindowPositionChange = useCallback((position: { x: number; y: number }) => {
		fireAndForget(emit('update-config', { windowPosition: position }), "Failed to emit window position update");
	}, []);

	const handleManualWindowPositioningChange = useCallback((enabled: boolean) => {
		fireAndForget(emit('update-config', { manualWindowPositioning: enabled }), "Failed to emit manual window positioning update");
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
			fireAndForget(
				syncTrayBatteryIcon(registeredDevices, config.trayIconComponents),
				"Failed to sync tray battery icon",
			);
		}, 60);
		return () => clearTimeout(id);
	}, [registeredDevices, config.trayIconComponents, isConfigLoaded]);

	async function fetchDevices() {
		setState(State.fetchingDevices);
		setError("");

		const isMac = platform() === 'macos';
		const createTimeoutError = () => {
			let msg = "Failed to fetch devices.";
			if (isMac) {
				msg += " If you are using macOS, please make sure Bluetooth permission is granted.";
			}
			return new Error(msg);
		};

		try {
			const result = await withTimeout(
				listBatteryDevices(),
				DEVICE_FETCH_TIMEOUT_MS,
				createTimeoutError,
			);
			setDevices(result);
			setState(State.addDeviceModal);
		} catch (e: unknown) {
			let msg = e instanceof Error ? e.message : String(e);
			if (isMac && !msg.includes("Bluetooth permission")) {
				msg += " If you are using macOS, please make sure Bluetooth permission is granted.";
			}
			setError(msg);
			setState(State.addDeviceModal);
		}
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
				isCollapsed: isNotificationMonitorMode && infoArray.length === 0 && config.autoCollapseDisconnectedDevices,
			};
			commitRegisteredDevices(prev => [...prev, newDevice]);
			handleCloseModal();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(`Failed to add device: ${msg}`);
			setState(State.addDeviceModal);
		}
	};

	const { updateBatteryInfo, autoCollapseDisconnectedDevicesRef } = useBatteryPolling({
		isPollingMode,
		isConfigLoaded,
		isDeviceLoaded,
		fetchInterval: config.fetchInterval,
		registeredDevicesRef,
		commitRegisteredDevices,
		pushNotification: config.pushNotification,
		pushNotificationWhen: config.pushNotificationWhen,
		lowBatteryThreshold: config.lowBatteryThreshold,
		highBatteryThreshold: config.highBatteryThreshold,
		autoCollapseDisconnectedDevices: config.autoCollapseDisconnectedDevices,
	});

	const { activeNotificationMonitorsRef } = useNotificationMonitors({
		isNotificationMonitorMode,
		isConfigLoaded,
		isDeviceLoaded,
		registeredDeviceIdsKey,
		autoCollapseDisconnectedDevicesRef,
		commitRegisteredDevices,
	});

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
	}, [isNotificationMonitorMode, commitRegisteredDevices, activeNotificationMonitorsRef]);

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
	}, [deviceList, state, panelLayoutRevision, config.manualWindowPositioning, isConfigLoaded]);

	useEffect(() => {
		if (!isDeviceLoaded) {
			return;
		}
		const unlistenPromise = listen<BatteryInfoNotificationEvent>("battery-info-notification", event => {
			const payload = event.payload;
			const batteryLevel = payload.battery_info.battery_level;
			// Record battery history for notification-mode updates
			if (batteryLevel !== null) {
				const device = registeredDevicesRef.current.find(d => d.id === payload.id);
				if (device) {
					fireAndForget((async () => {
						await appendBatteryHistory(
							device.name,
							device.id,
							payload.battery_info.user_description ?? 'Central',
							batteryLevel,
						);
						await emit('battery-history-updated', { deviceId: payload.id });
					})(), `Failed to update battery history for ${payload.id}`);
				}
			}
			commitRegisteredDevices(prev => prev.map(device => {
				if (device.id !== payload.id) {
					return device;
				}
				return expandIfConnected({
					...device,
					batteryInfos: upsertBatteryInfo(device.batteryInfos, payload.battery_info),
					isDisconnected: false,
				}, autoCollapseDisconnectedDevicesRef.current);
			}));
		});

		return () => {
			fireAndForget(
				unlistenPromise.then(unlisten => unlisten()),
				"Failed to clean up battery info listener",
			);
		};
	}, [isDeviceLoaded, config.autoCollapseDisconnectedDevices, commitRegisteredDevices, autoCollapseDisconnectedDevicesRef, registeredDevicesRef]);

	const previousAutoCollapseDisconnectedDevicesRef = useRef(config.autoCollapseDisconnectedDevices);
	useEffect(() => {
		if (!isDeviceLoaded) {
			previousAutoCollapseDisconnectedDevicesRef.current = config.autoCollapseDisconnectedDevices;
			return;
		}

		const wasEnabled = previousAutoCollapseDisconnectedDevicesRef.current;
		previousAutoCollapseDisconnectedDevicesRef.current = config.autoCollapseDisconnectedDevices;
		if (wasEnabled || !config.autoCollapseDisconnectedDevices) {
			return;
		}

		commitRegisteredDevices((prev) =>
			prev.map((device) => collapseIfDisconnected(device, true)),
		);
	}, [isDeviceLoaded, config.autoCollapseDisconnectedDevices, commitRegisteredDevices]);

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
						notificationMessage = `${getRegisteredDeviceDisplayName(device)} has been connected.`;
					}
				} else if (config.pushNotification && config.pushNotificationWhen[NotificationType.Disconnected]) {
					notificationMessage = `${getRegisteredDeviceDisplayName(device)} has been disconnected.`;
				}

				return nextDisconnected
					? collapseIfDisconnected(
						{ ...device, isDisconnected: true },
						autoCollapseDisconnectedDevicesRef.current,
					)
					: expandIfConnected(
						{ ...device, isDisconnected: false },
						autoCollapseDisconnectedDevicesRef.current,
					);
			}));

			if (notificationMessage) {
				fireAndForget(sendNotification(notificationMessage), "Failed to send monitor status notification");
			}
		});

		return () => {
			fireAndForget(
				unlistenPromise.then(unlisten => unlisten()),
				"Failed to clean up battery monitor status listener",
			);
		};
	}, [isDeviceLoaded, config.autoCollapseDisconnectedDevices, config.pushNotification, config.pushNotificationWhen, commitRegisteredDevices, autoCollapseDisconnectedDevicesRef]);


	const handleExitSettings = useCallback(() => {
		setState(State.main);
	}, []);

	const handleOpenSettings = useCallback(() => {
		setState(State.settings);
	}, []);

	const handleChartOpenChange = useCallback((isOpen: boolean) => {
		setState(isOpen ? State.chart : State.main);
	}, []);

	const handlePanelLayoutChange = useCallback(() => {
		setPanelLayoutRevision((prev) => prev + 1);
	}, []);

	return (
		<div id="app" className={`relative flex flex-col bg-background text-foreground rounded-lg p-2 ${
			state === State.main && deviceList.length > 0 ? 'w-90' :
			state === State.chart ? 'w-110 h-90' :
			state === State.fetchingBatteryInfo ? 'w-90 min-h-58' :
			state === State.settings ? 'w-95 min-h-90' :
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
								<ul className="app-scrollbar max-h-60 overflow-y-auto rounded-sm">
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
								onLayoutChange={handlePanelLayoutChange}
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
