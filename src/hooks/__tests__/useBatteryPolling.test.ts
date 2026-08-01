import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBatteryPolling } from "@/hooks/useBatteryPolling";
import { getBatteryInfo, type BatteryInfo } from "@/utils/ble";
import { recordBatteryReadings } from "@/utils/batteryHistory";
import { notifyBatteryEdgeTransitions } from "@/utils/batteryEdgeNotification";
import { sendNotification } from "@/utils/notification";
import { NotificationType } from "@/utils/config";
import type { RegisteredDevice } from "@/utils/appHelpers";

vi.mock("@/utils/ble", () => ({
	getBatteryInfo: vi.fn(),
}));

vi.mock("@/utils/batteryHistory", () => ({
	recordBatteryReadings: vi.fn(),
}));

vi.mock("@/utils/batteryEdgeNotification", () => ({
	notifyBatteryEdgeTransitions: vi.fn(),
}));

vi.mock("@/utils/notification", () => ({
	sendNotification: vi.fn(),
}));

vi.mock("@/utils/common", () => ({
	sleep: vi.fn(async () => undefined),
	fireAndForget: vi.fn((promise: Promise<unknown>, _context: string) => {
		void promise.catch(() => undefined);
	}),
}));

const connectedBatteryInfos: BatteryInfo[] = [
	{ battery_level: 50, user_description: "Central" },
];

const notificationFlags: Record<NotificationType, boolean> = {
	[NotificationType.LowBattery]: true,
	[NotificationType.HighBattery]: true,
	[NotificationType.Connected]: true,
	[NotificationType.Disconnected]: true,
};

type PollingOptions = Parameters<typeof useBatteryPolling>[0];
type RenderOverrides = Partial<Omit<PollingOptions, "registeredDevicesRef" | "commitRegisteredDevices">> & {
	device?: RegisteredDevice;
};

function createDevice(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
	return {
		id: "kbd-1",
		name: "Mock Keyboard",
		batteryInfos: connectedBatteryInfos,
		isDisconnected: false,
		isCollapsed: false,
		...overrides,
	};
}

function renderPolling(overrides: RenderOverrides = {}) {
	const { device = createDevice(), ...optionOverrides } = overrides;
	const registeredDevicesRef = { current: [device] };
	let devices = registeredDevicesRef.current;
	const commitRegisteredDevices = vi.fn((recipe: (current: RegisteredDevice[]) => RegisteredDevice[]) => {
		devices = recipe(devices);
		registeredDevicesRef.current = devices;
	});
	const options: PollingOptions = {
		isPollingMode: true,
		isConfigLoaded: true,
		isDeviceLoaded: true,
		fetchInterval: 60_000,
		registeredDevicesRef,
		commitRegisteredDevices,
		pushNotification: true,
		pushNotificationWhen: notificationFlags,
		lowBatteryThreshold: 20,
		ignoreZeroPercent: true,
		highBatteryThreshold: 80,
		autoCollapseDisconnectedDevices: false,
		...optionOverrides,
	};
	const view = renderHook(() => useBatteryPolling(options));
	return {
		...view,
		device,
		getDevices: () => devices,
	};
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("useBatteryPolling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.mocked(getBatteryInfo).mockResolvedValue(connectedBatteryInfos);
		vi.mocked(sendNotification).mockResolvedValue(true);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("retries three times for a connected device", async () => {
		const device = createDevice();
		vi.mocked(getBatteryInfo).mockRejectedValue(new Error("BLE error"));
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(getBatteryInfo).toHaveBeenCalledTimes(3);
		expect(view.getDevices()[0]).toMatchObject({ isDisconnected: true });
	});

	it("tries only once for an already-disconnected device", async () => {
		const device = createDevice({ isDisconnected: true });
		vi.mocked(getBatteryInfo).mockRejectedValue(new Error("BLE error"));
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(getBatteryInfo).toHaveBeenCalledTimes(1);
	});

	it("sends a connected notification only on disconnected-to-connected transition", async () => {
		const device = createDevice({ isDisconnected: true });
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(sendNotification).toHaveBeenCalledTimes(1);
		expect(sendNotification).toHaveBeenCalledWith("Mock Keyboard has been connected.");

		vi.mocked(sendNotification).mockClear();
		await act(async () => {
			await view.result.current.updateBatteryInfo(view.getDevices()[0]);
		});

		expect(sendNotification).not.toHaveBeenCalled();
	});

	it("keeps a reconnected device connected when its notification fails", async () => {
		const device = createDevice({ isDisconnected: true });
		vi.mocked(sendNotification).mockRejectedValue(new Error("notification failed"));
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(view.getDevices()[0]).toMatchObject({ isDisconnected: false });
	});
	it("sends a disconnected notification only on connected-to-disconnected transition", async () => {
		const device = createDevice();
		vi.mocked(getBatteryInfo).mockRejectedValue(new Error("BLE error"));
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(sendNotification).toHaveBeenCalledWith("Mock Keyboard has been disconnected.");

		vi.mocked(sendNotification).mockClear();
		vi.mocked(getBatteryInfo).mockClear();
		await act(async () => {
			await view.result.current.updateBatteryInfo(view.getDevices()[0]);
		});

		expect(getBatteryInfo).toHaveBeenCalledTimes(1);
		expect(sendNotification).not.toHaveBeenCalled();
	});

	it("records readings and forwards edge transitions on success", async () => {
		const device = createDevice();
		const fetchedInfos: BatteryInfo[] = [
			{ battery_level: 18, user_description: "Central" },
		];
		vi.mocked(getBatteryInfo).mockResolvedValue(fetchedInfos);
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(recordBatteryReadings).toHaveBeenCalledOnce();
		expect(recordBatteryReadings).toHaveBeenCalledWith(device, fetchedInfos);
		expect(notifyBatteryEdgeTransitions).toHaveBeenCalledOnce();
		expect(notifyBatteryEdgeTransitions).toHaveBeenCalledWith(expect.objectContaining({
		deviceId: device.id,
		newBatteryInfos: fetchedInfos,
	}));
	});

	it("success commits merged battery infos and clears isDisconnected", async () => {
		const device = createDevice({ isDisconnected: true });
		const fetchedInfos: BatteryInfo[] = [
			{ battery_level: 75, user_description: "Central" },
		];
		vi.mocked(getBatteryInfo).mockResolvedValue(fetchedInfos);
		const view = renderPolling({ device, isPollingMode: false });

		await act(async () => {
			await view.result.current.updateBatteryInfo(device);
		});

		expect(view.getDevices()[0]).toMatchObject({
			batteryInfos: fetchedInfos,
			isDisconnected: false,
		});
	});

	it("polls immediately and then on each interval", async () => {
		const view = renderPolling();

		expect(getBatteryInfo).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(getBatteryInfo).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(getBatteryInfo).toHaveBeenCalledTimes(3);
		view.unmount();
	});

	it("skips a cycle while one is in flight", async () => {
		const resolvers: Array<(infos: BatteryInfo[]) => void> = [];
		vi.mocked(getBatteryInfo).mockImplementation(
			() => new Promise(resolve => resolvers.push(resolve)),
		);
		const view = renderPolling();

		expect(getBatteryInfo).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(getBatteryInfo).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolvers.shift()!(connectedBatteryInfos);
			await flushPromises();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(getBatteryInfo).toHaveBeenCalledTimes(2);

		await act(async () => {
			resolvers.shift()!(connectedBatteryInfos);
			await flushPromises();
		});
		view.unmount();
	});

	it("stops polling on unmount", async () => {
		const view = renderPolling();
		view.unmount();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});

		expect(getBatteryInfo).toHaveBeenCalledTimes(1);
	});

	it("does not poll when isPollingMode is false", async () => {
		const view = renderPolling({ isPollingMode: false });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});

		expect(getBatteryInfo).not.toHaveBeenCalled();
		view.unmount();
	});

	it("reloadAll returns false while a cycle is in flight, true otherwise", async () => {
		let resolveReload!: (infos: BatteryInfo[]) => void;
		vi.mocked(getBatteryInfo).mockImplementation(
			() => new Promise(resolve => {
				resolveReload = resolve;
			}),
		);
		const view = renderPolling({ isPollingMode: false });
		let firstReload!: Promise<boolean>;

		await act(async () => {
			firstReload = view.result.current.reloadAll();
		});
		expect(getBatteryInfo).toHaveBeenCalledTimes(1);

		await act(async () => {
			expect(await view.result.current.reloadAll()).toBe(false);
		});

		await act(async () => {
			resolveReload(connectedBatteryInfos);
			expect(await firstReload).toBe(true);
		});

		vi.mocked(getBatteryInfo).mockResolvedValue(connectedBatteryInfos);
		await act(async () => {
			expect(await view.result.current.reloadAll()).toBe(true);
		});
		view.unmount();
	});
});
