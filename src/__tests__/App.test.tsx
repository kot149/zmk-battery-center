import { act, render, screen, waitFor } from "@testing-library/react";
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
let pendingDeviceGetResolve: ((value: unknown) => void) | null = null;

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
		pendingDeviceGetResolve = null;

		mockListen.mockImplementation(async (event: string, handler: unknown) => {
			if (event === "battery-info-notification") {
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
				pendingDeviceGetResolve = resolve;
			});
		});
	});

	it("does not persist devices before initial load completes", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});
		expect(mockStore.set).not.toHaveBeenCalled();

		await act(async () => {
			pendingDeviceGetResolve?.([
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
	});

	it("updates disconnected state from battery-monitor-status events", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockStore.get).toHaveBeenCalledWith("devices");
		});

		await act(async () => {
			pendingDeviceGetResolve?.([
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

		await act(async () => {
			pendingDeviceGetResolve?.([]);
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
});
