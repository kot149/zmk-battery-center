import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExternalBatteryIntegration } from "@/hooks/useExternalBatteryIntegration";
import type { RegisteredDevice } from "@/utils/appHelpers";

const mocks = vi.hoisted(() => ({
	buildExternalBatteryDevices: vi.fn((devices: RegisteredDevice[]) => devices.map(device => ({ id: device.id }))),
	buildRunCatProjection: vi.fn(() => ({ title: "test" })),
	completeExternalBatteryRefresh: vi.fn(async () => undefined),
	getPendingExternalBatteryRefresh: vi.fn(async () => null),
	publishExternalBatterySnapshot: vi.fn(async () => undefined),
	listen: vi.fn(),
}));

vi.mock("@/utils/externalBatteryIntegration", () => ({
	buildExternalBatteryDevices: mocks.buildExternalBatteryDevices,
	buildRunCatProjection: mocks.buildRunCatProjection,
	completeExternalBatteryRefresh: mocks.completeExternalBatteryRefresh,
	getPendingExternalBatteryRefresh: mocks.getPendingExternalBatteryRefresh,
	publishExternalBatterySnapshot: mocks.publishExternalBatterySnapshot,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: mocks.listen,
}));

function device(): RegisteredDevice {
	return {
		id: "kbd-1",
		name: "Keyboard",
		batteryInfos: [],
		isDisconnected: false,
		isCollapsed: false,
	};
}

async function flushPromises() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("useExternalBatteryIntegration", () => {
	let requestHandler: ((event: { payload: { schemaVersion: 1; requestId: string; requestedAtUnixMs: number } }) => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		requestHandler = undefined;
		mocks.listen.mockImplementation(async (_event: string, handler: typeof requestHandler) => {
			requestHandler = handler;
			return vi.fn();
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function renderIntegration(loaded: boolean, devices: RegisteredDevice[] = []) {
		const snapshot = { devices, sourceRevision: loaded ? 2 : 0 };
		const refreshAllForExternal = vi.fn(async () => [{ id: "kbd-1", status: "updated" as const }]);
		const refreshAllNotificationMonitors = vi.fn(async () => [{ id: "kbd-1", status: "updated" as const }]);
		const view = renderHook(
			({ isDeviceLoaded, registeredDevices }) => useExternalBatteryIntegration({
				isDeviceLoaded,
				registeredDevices,
				getRegisteredDevicesSnapshot: () => snapshot,
				isPollingMode: true,
				refreshAllForExternal,
				refreshAllNotificationMonitors,
			}),
			{ initialProps: { isDeviceLoaded: loaded, registeredDevices: loaded ? devices : undefined } },
		);
		return { ...view, refreshAllForExternal, refreshAllNotificationMonitors, rerenderWith: (nextLoaded: boolean, nextDevices: RegisteredDevice[]) => {
			snapshot.devices = nextDevices;
			snapshot.sourceRevision = nextLoaded ? 3 : 0;
			view.rerender({ isDeviceLoaded: nextLoaded, registeredDevices: nextLoaded ? nextDevices : undefined });
		} };
	}

	it("waits for device loading before publishing", async () => {
		const view = renderIntegration(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect(mocks.publishExternalBatterySnapshot).not.toHaveBeenCalled();

		const devices = [device()];
		view.rerenderWith(true, devices);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(75);
		});
		expect(mocks.publishExternalBatterySnapshot).toHaveBeenCalledWith(
			3,
			[{ id: "kbd-1" }],
			{ title: "test" },
		);
	});

	it("routes one refresh event and completes from the latest snapshot", async () => {
		const devices = [device()];
		const view = renderIntegration(true, devices);
		await act(async () => flushPromises());
		expect(requestHandler).toBeDefined();

		await act(async () => {
			requestHandler?.({ payload: { schemaVersion: 1, requestId: "client-1", requestedAtUnixMs: 100 } });
		});
		await act(async () => flushPromises());
		expect(view.refreshAllForExternal).toHaveBeenCalledOnce();
		await act(async () => flushPromises());
		expect(mocks.completeExternalBatteryRefresh).toHaveBeenCalledWith(
			"client-1",
			2,
			[{ id: "kbd-1", status: "updated" }],
			[{ id: "kbd-1" }],
			{ title: "test" },
		);
		view.unmount();
	});

	it("keeps a request active when completion publication fails", async () => {
		const devices = [device()];
		mocks.completeExternalBatteryRefresh.mockRejectedValue(new Error("publish failed"));
		const view = renderIntegration(true, devices);
		await act(async () => flushPromises());
		expect(requestHandler).toBeDefined();

		await act(async () => {
			requestHandler?.({ payload: { schemaVersion: 1, requestId: "client-1", requestedAtUnixMs: 100 } });
		});
		await act(async () => flushPromises());
		expect(view.refreshAllForExternal).toHaveBeenCalledOnce();
		expect(mocks.completeExternalBatteryRefresh).toHaveBeenCalledOnce();

		await act(async () => {
			requestHandler?.({ payload: { schemaVersion: 1, requestId: "client-1", requestedAtUnixMs: 100 } });
		});
		await act(async () => flushPromises());
		expect(view.refreshAllForExternal).toHaveBeenCalledOnce();
		view.unmount();
	});
});
