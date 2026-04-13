import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { defaultConfig } from "@/utils/config";

const mockStore = {
	get: vi.fn(),
	set: vi.fn(async () => undefined),
};

const mockListen = vi.fn();
const mockUnlistenBatteryInfo = vi.fn();
const mockUnlistenMonitorStatus = vi.fn();

let monitorStatusHandler: ((event: { payload: { id: string; connected: boolean } }) => void) | undefined;
let batteryInfoNotificationHandler:
	| ((event: {
			payload: {
				id: string;
				battery_info: { battery_level: number | null; user_description: string | null };
			};
	  }) => void)
	| undefined;

/** Resolves every in-flight `mockStore.get("devices")` promise (e.g. React StrictMode double effect). */
let deviceGetResolvers: Array<(value: unknown) => void> = [];

function resolveDeviceStoreGets(payload: unknown) {
	while (deviceGetResolvers.length > 0) {
		const resolve = deviceGetResolvers.shift()!;
		resolve(payload);
	}
}

function getStoreSetCalls(): [string, unknown][] {
	return mockStore.set.mock.calls as unknown as [string, unknown][];
}

vi.mock("@/context/ConfigContext", () => ({
	useConfigContext: () => ({
		config: defaultConfig,
		isConfigLoaded: true,
	}),
}));

vi.mock("@/utils/storage", () => ({
	load: vi.fn(async () => mockStore),
	getStorePath: vi.fn(async (filename: string) => filename),
}));

vi.mock("@/utils/ble", () => ({
	listBatteryDevices: vi.fn(async () => [{ id: "kbd-1", name: "MockBoard One" }]),
	getBatteryInfo: vi.fn(async () => [{ battery_level: 87, user_description: "Central" }]),
	startBatteryNotificationMonitor: vi.fn(async () => [{ battery_level: 87, user_description: "Central" }]),
	stopBatteryNotificationMonitor: vi.fn(async () => undefined),
	stopAllBatteryMonitors: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useWindowEvents", () => ({
	useWindowEvents: vi.fn(),
}));

vi.mock("@/hooks/useTrayEvents", () => ({
	useTrayEvents: vi.fn(),
}));

vi.mock("@/utils/window", () => ({
	moveWindowToTrayCenter: vi.fn(async () => undefined),
	resizeWindowToContent: vi.fn(async () => undefined),
}));

vi.mock("@/utils/notification", () => ({
	sendNotification: vi.fn(async () => true),
}));

vi.mock("@/utils/batteryHistory", () => ({
	appendBatteryHistory: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
	platform: () => "windows",
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: vi.fn(async () => undefined),
	listen: (...args: unknown[]) => mockListen(...args),
}));

describe("App", () => {
	beforeEach(() => {
		mockStore.set.mockClear();
		mockStore.get.mockClear();
		mockListen.mockReset();
		mockUnlistenBatteryInfo.mockReset();
		mockUnlistenMonitorStatus.mockReset();
		monitorStatusHandler = undefined;
		batteryInfoNotificationHandler = undefined;
		deviceGetResolvers = [];

		mockListen.mockImplementation(async (event: string, handler: unknown) => {
			if (event === "battery-info-notification") {
				batteryInfoNotificationHandler = handler as typeof batteryInfoNotificationHandler;
				return mockUnlistenBatteryInfo;
			}
			if (event === "battery-monitor-status") {
				monitorStatusHandler = handler as typeof monitorStatusHandler;
				return mockUnlistenMonitorStatus;
			}
			return vi.fn();
		});

		mockStore.get.mockImplementation(() => {
			return new Promise((resolve) => {
				deviceGetResolvers.push(resolve);
			});
		});
	});

	it("does not persist devices before initial load completes", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});
		expect(mockStore.set).not.toHaveBeenCalled();
		const deviceSetCallsBeforeHydrate = getStoreSetCalls().filter((c) => c[0] === "devices");
		expect(deviceSetCallsBeforeHydrate).toHaveLength(0);

		await act(async () => {
			resolveDeviceStoreGets([
				{
					id: "kbd-1",
					name: "MockBoard One",
					isDisconnected: false,
					batteryInfos: [{ battery_level: 87, user_description: "Central" }],
				},
			]);
		});

		await waitFor(() => {
			expect(mockStore.set).toHaveBeenCalledWith("devices", expect.any(Array));
		});
		const persistedWhileEmpty = getStoreSetCalls().some(
			(c) => c[0] === "devices" && Array.isArray(c[1]) && (c[1] as unknown[]).length === 0,
		);
		expect(persistedWhileEmpty).toBe(false);
	});

	it("updates disconnected state from battery-monitor-status events", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});

		await act(async () => {
			resolveDeviceStoreGets([
				{
					id: "kbd-1",
					name: "MockBoard One",
					isDisconnected: false,
					batteryInfos: [{ battery_level: 87, user_description: "Central" }],
				},
			]);
		});

		await waitFor(() => {
			expect(screen.getByText("MockBoard One")).toBeTruthy();
		});

		await act(async () => {
			monitorStatusHandler?.({ payload: { id: "kbd-1", connected: false } });
		});
		expect(screen.getByText("disconnected")).toBeTruthy();

		await act(async () => {
			monitorStatusHandler?.({ payload: { id: "kbd-1", connected: true } });
		});
		expect(screen.queryByText("disconnected")).toBeNull();
	});

	it("cleans up event listeners on unmount", async () => {
		const view = render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});

		await act(async () => {
			resolveDeviceStoreGets([]);
		});

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("battery-info-notification", expect.any(Function));
			expect(mockListen).toHaveBeenCalledWith("battery-monitor-status", expect.any(Function));
		});

		view.unmount();

		await waitFor(() => {
			expect(mockUnlistenBatteryInfo).toHaveBeenCalledTimes(1);
			expect(mockUnlistenMonitorStatus).toHaveBeenCalledTimes(1);
		});
	});

	it("does not register BLE listeners until the device store has been read from disk", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});

		const bleChannels = mockListen.mock.calls.map((c) => c[0] as string);
		expect(bleChannels).not.toContain("battery-info-notification");
		expect(bleChannels).not.toContain("battery-monitor-status");

		await act(async () => {
			resolveDeviceStoreGets([
				{
					id: "kbd-1",
					name: "MockBoard One",
					isDisconnected: false,
					batteryInfos: [{ battery_level: 87, user_description: "Central" }],
				},
			]);
		});

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("battery-info-notification", expect.any(Function));
			expect(mockListen).toHaveBeenCalledWith("battery-monitor-status", expect.any(Function));
		});
	});

	it("battery-info-notification updates persisted devices without writing an empty device list", async () => {
		const saved = [
			{
				id: "kbd-1",
				name: "MockBoard One",
				isDisconnected: false,
				batteryInfos: [{ battery_level: 87, user_description: "Central" }],
			},
		];

		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});
		expect(mockStore.set).not.toHaveBeenCalled();

		await act(async () => {
			resolveDeviceStoreGets(saved);
		});

		await waitFor(() => {
			expect(batteryInfoNotificationHandler).toBeDefined();
			expect(screen.getByText("MockBoard One")).toBeTruthy();
		});

		mockStore.set.mockClear();

		await act(async () => {
			batteryInfoNotificationHandler?.({
				payload: {
					id: "kbd-1",
					battery_info: { battery_level: 42, user_description: "Central" },
				},
			});
		});

		await waitFor(() => {
			expect(mockStore.set).toHaveBeenCalled();
		});
		const emptyPersist = getStoreSetCalls().some(
			(c) => c[0] === "devices" && Array.isArray(c[1]) && (c[1] as unknown[]).length === 0,
		);
		expect(emptyPersist).toBe(false);
		const lastDevicesWrite = [...getStoreSetCalls()].reverse().find((c) => c[0] === "devices");
		expect(lastDevicesWrite?.[1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "kbd-1",
					batteryInfos: expect.arrayContaining([
						expect.objectContaining({ battery_level: 42, user_description: "Central" }),
					]),
				}),
			]),
		);
	});

	it("hydrates saved devices when StrictMode runs the load effect more than once", async () => {
		const saved = [
			{
				id: "kbd-1",
				name: "MockBoard One",
				isDisconnected: false,
				batteryInfos: [{ battery_level: 87, user_description: "Central" }],
			},
		];

		render(
			<StrictMode>
				<App />
			</StrictMode>,
		);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
			expect(deviceGetResolvers.length).toBeGreaterThanOrEqual(1);
		});

		await act(async () => {
			resolveDeviceStoreGets(saved);
		});

		await waitFor(() => {
			expect(screen.getByText("MockBoard One")).toBeTruthy();
		});

		const rows = screen.getAllByText("MockBoard One");
		expect(rows).toHaveLength(1);
	});
});
