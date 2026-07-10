import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationMonitors } from "../useNotificationMonitors";
import {
	startBatteryNotificationMonitor,
	stopBatteryNotificationMonitor,
	stopAllBatteryMonitors,
} from "@/utils/ble";
import type { BatteryInfo } from "@/utils/ble";

vi.mock("@/utils/ble", () => ({
	startBatteryNotificationMonitor: vi.fn(),
	stopBatteryNotificationMonitor: vi.fn(async () => undefined),
	stopAllBatteryMonitors: vi.fn(async () => undefined),
}));

type HookProps = {
	key: string;
	mode: boolean;
	commit: (recipe: (current: never[]) => never[]) => void;
};

const CONNECTED_INFO: BatteryInfo[] = [{ battery_level: 50, user_description: "Central" }];

describe("useNotificationMonitors", () => {
	let startResolvers: Map<string, (value: BatteryInfo[]) => void>;

	beforeEach(() => {
		startResolvers = new Map();
		vi.mocked(startBatteryNotificationMonitor).mockReset();
		vi.mocked(stopBatteryNotificationMonitor).mockClear();
		vi.mocked(stopAllBatteryMonitors).mockClear();
		vi.mocked(startBatteryNotificationMonitor).mockImplementation(
			(id: string) => new Promise<BatteryInfo[]>(resolve => {
				startResolvers.set(id, resolve);
			}),
		);
	});

	function renderMonitors(initialProps: Partial<HookProps> = {}) {
		const props: HookProps = {
			key: "A",
			mode: true,
			commit: vi.fn(),
			...initialProps,
		};
		const autoCollapseDisconnectedDevicesRef = { current: false };
		return renderHook(
			({ key, mode, commit }: HookProps) => useNotificationMonitors({
				isNotificationMonitorMode: mode,
				isConfigLoaded: true,
				isDeviceLoaded: true,
				registeredDeviceIdsKey: key,
				autoCollapseDisconnectedDevicesRef,
				commitRegisteredDevices: commit,
			}),
			{ initialProps: props },
		);
	}

	async function resolveStart(id: string, value: BatteryInfo[] = CONNECTED_INFO) {
		await waitFor(() => {
			expect(startResolvers.get(id)).toBeDefined();
		});
		await act(async () => {
			startResolvers.get(id)!(value);
		});
	}

	it("queues a rerendered reconciliation behind the in-flight one", async () => {
		const view = renderMonitors({ key: "A" });

		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("A");
		});

		view.rerender({ key: "A,B", mode: true, commit: vi.fn() });

		// The second run must not start B while A's start is still pending.
		expect(startBatteryNotificationMonitor).toHaveBeenCalledTimes(1);

		await resolveStart("A");
		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("B");
		});
		await resolveStart("B");

		await waitFor(() => {
			expect(view.result.current.activeNotificationMonitorsRef.current).toEqual(new Set(["A", "B"]));
		});
		expect(startBatteryNotificationMonitor).toHaveBeenCalledTimes(2);
	});

	it("never stops a monitor whose start resolved after the run was superseded", async () => {
		const view = renderMonitors({ key: "X" });

		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("X");
		});

		// Supersede the in-flight run without changing the desired set.
		view.rerender({ key: "X", mode: true, commit: vi.fn() });

		await resolveStart("X");

		await waitFor(() => {
			expect(view.result.current.activeNotificationMonitorsRef.current).toEqual(new Set(["X"]));
		});
		expect(stopBatteryNotificationMonitor).not.toHaveBeenCalled();
		expect(startBatteryNotificationMonitor).toHaveBeenCalledTimes(1);
	});

	it("lets the successor run start the devices a superseded run skipped", async () => {
		const view = renderMonitors({ key: "A,B,C" });

		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("A");
		});

		view.rerender({ key: "A,B,C", mode: true, commit: vi.fn() });

		await resolveStart("A");

		// The superseded run stops; the successor starts the remaining devices.
		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("B");
		});
		await resolveStart("B");
		await waitFor(() => {
			expect(startBatteryNotificationMonitor).toHaveBeenCalledWith("C");
		});
		await resolveStart("C");

		await waitFor(() => {
			expect(view.result.current.activeNotificationMonitorsRef.current).toEqual(new Set(["A", "B", "C"]));
		});
		const startedIds = vi.mocked(startBatteryNotificationMonitor).mock.calls.map(c => c[0]);
		expect(startedIds).toEqual(["A", "B", "C"]);
	});

	it("stops all monitors when notification-monitor mode turns off", async () => {
		const view = renderMonitors({ key: "A" });

		await resolveStart("A");
		await waitFor(() => {
			expect(view.result.current.activeNotificationMonitorsRef.current).toEqual(new Set(["A"]));
		});

		view.rerender({ key: "A", mode: false, commit: vi.fn() });

		await waitFor(() => {
			expect(stopAllBatteryMonitors).toHaveBeenCalled();
		});
		expect(stopBatteryNotificationMonitor).toHaveBeenCalledWith("A");
		expect(view.result.current.activeNotificationMonitorsRef.current).toEqual(new Set());
	});
});
