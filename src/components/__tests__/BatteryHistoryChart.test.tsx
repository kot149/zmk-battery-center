import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { RegisteredDevice } from "@/App";
import BatteryHistoryChart from "../BatteryHistoryChart";
import { ConfigProvider } from "@/context/ConfigContext";
import { ThemeProvider } from "@/context/theme-provider";

const mockReadBatteryHistory = vi.fn();
const mockListen = vi.fn();
const mockUnlisten = vi.fn();
const mockRecharts = vi.hoisted(() => ({
	lineChartData: [] as unknown[],
	xAxisTicks: [] as number[],
	tooltipContent: undefined as
		| ((props: { active?: boolean; payload?: unknown[]; label?: unknown }) => ReactNode)
		| undefined,
}));

type ChartContainerProps = {
	children?: ReactNode;
	data?: unknown[];
	ticks?: number[];
};

vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: ChartContainerProps) => <div data-testid="responsive-container">{children}</div>,
	LineChart: ({ children, data }: ChartContainerProps) => {
		mockRecharts.lineChartData = data ?? [];
		return <div data-testid="line-chart">{children}</div>;
	},
	Line: () => null,
	XAxis: ({ ticks }: ChartContainerProps) => {
		mockRecharts.xAxisTicks = ticks ?? [];
		return <div data-testid="x-axis" />;
	},
	YAxis: () => null,
	Tooltip: ({ content }: { content?: (props: { active?: boolean; payload?: unknown[]; label?: unknown }) => ReactNode }) => {
		mockRecharts.tooltipContent = content;
		return null;
	},
	Legend: () => null,
	ReferenceLine: () => null,
}));

vi.mock("@/utils/batteryHistory", () => ({
	readBatteryHistory: (...args: unknown[]) => mockReadBatteryHistory(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: vi.fn(async () => undefined),
	listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("@/utils/storage", () => ({
	load: vi.fn(async () => ({
		get: vi.fn(async () => undefined),
		set: vi.fn(async () => undefined),
	})),
	getStorePath: vi.fn(async (filename: string) => filename),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
	enable: vi.fn(async () => undefined),
	isEnabled: vi.fn(async () => false),
	disable: vi.fn(async () => undefined),
}));

vi.mock("@/utils/notification", () => ({
	requestNotificationPermission: vi.fn(async () => true),
}));

const device: RegisteredDevice = {
	id: "kbd-1",
	name: "MockBoard One",
	batteryInfos: [{ battery_level: 87, user_description: "Central" }],
	isDisconnected: false,
};

function renderChart() {
	return render(
		<ThemeProvider defaultTheme="dark">
			<ConfigProvider>
				<BatteryHistoryChart device={device} onClose={vi.fn()} />
			</ConfigProvider>
		</ThemeProvider>,
	);
}

describe("BatteryHistoryChart", () => {
	beforeEach(() => {
		mockReadBatteryHistory.mockReset();
		mockListen.mockReset();
		mockUnlisten.mockReset();
		mockRecharts.lineChartData = [];
		mockRecharts.xAxisTicks = [];
		mockRecharts.tooltipContent = undefined;
		mockListen.mockImplementation(async () => mockUnlisten);
	});

	it("shows empty message when no history exists", async () => {
		mockReadBatteryHistory.mockResolvedValue([]);
		renderChart();

		await waitFor(() => {
			expect(screen.getByText("No history recorded yet")).toBeTruthy();
		});
	});

	it("reloads when battery-history-updated event is received for the same device", async () => {
		mockReadBatteryHistory
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					user_description: "Central",
					battery_level: 80,
				},
			]);

		renderChart();

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("battery-history-updated", expect.any(Function));
		});
		const handler = mockListen.mock.calls.find((call) => call[0] === "battery-history-updated")?.[1] as
			| ((event: { payload: { deviceId: string } }) => void)
			| undefined;
		expect(handler).toBeDefined();

		await act(async () => {
			handler?.({ payload: { deviceId: "kbd-1" } });
		});

		await waitFor(() => {
			expect(mockReadBatteryHistory).toHaveBeenCalledTimes(2);
		});
	});

	it("does not reload for battery-history-updated events from other devices", async () => {
		mockReadBatteryHistory.mockResolvedValue([]);
		renderChart();

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("battery-history-updated", expect.any(Function));
		});
		const handler = mockListen.mock.calls.find((call) => call[0] === "battery-history-updated")?.[1] as
			| ((event: { payload: { deviceId: string } }) => void)
			| undefined;

		await act(async () => {
			handler?.({ payload: { deviceId: "kbd-2" } });
		});

		await waitFor(() => {
			expect(mockReadBatteryHistory).toHaveBeenCalledTimes(1);
		});
	});

	it("cleans up battery-history-updated listener on unmount", async () => {
		mockReadBatteryHistory.mockResolvedValue([]);
		const view = renderChart();

		await waitFor(() => {
			expect(mockListen).toHaveBeenCalledWith("battery-history-updated", expect.any(Function));
		});

		view.unmount();
		await waitFor(() => {
			expect(mockUnlisten).toHaveBeenCalled();
		});
	});

	it("opens settings panel from chart settings button", async () => {
		const user = userEvent.setup();
		mockReadBatteryHistory.mockResolvedValue([]);
		renderChart();

		await user.click(screen.getByRole("button", { name: "Chart settings" }));
		expect(screen.getByText("Range:")).toBeTruthy();
		expect(screen.getByText("Smoothing:")).toBeTruthy();
	});

	it("keeps explicit x-axis ticks even when history has gaps", async () => {
		mockReadBatteryHistory.mockResolvedValue([
			{
				timestamp: "2026-10-21T00:00:00.000Z",
				user_description: "Central",
				battery_level: 90,
			},
			{
				timestamp: "2026-11-04T00:00:00.000Z",
				user_description: "Central",
				battery_level: 75,
			},
		]);

		renderChart();

		await waitFor(() => {
			expect(mockRecharts.lineChartData.length).toBe(2);
			expect(mockRecharts.xAxisTicks.length).toBeGreaterThan(0);
		});

		const tickWithoutHistory = mockRecharts.xAxisTicks.find((tick) => {
			return !mockRecharts.lineChartData.some(
				(item) => (item as { timestamp: number }).timestamp === tick,
			);
		});
		expect(tickWithoutHistory).toBeDefined();
	});

	it("does not show tooltip content for tick-only rows without recorded data", async () => {
		mockReadBatteryHistory.mockResolvedValue([
			{
				timestamp: "2026-10-21T00:00:00.000Z",
				user_description: "Central",
				battery_level: 90,
			},
			{
				timestamp: "2026-11-04T00:00:00.000Z",
				user_description: "Central",
				battery_level: 75,
			},
		]);

		renderChart();

		await waitFor(() => {
			expect(mockRecharts.tooltipContent).toBeTypeOf("function");
			expect(mockRecharts.lineChartData.length).toBe(2);
			expect(mockRecharts.xAxisTicks.length).toBeGreaterThan(0);
		});

		const tickWithoutHistory = mockRecharts.xAxisTicks.find((tick) => {
			return !mockRecharts.lineChartData.some(
				(item) => (item as { timestamp: number }).timestamp === tick,
			);
		});
		expect(tickWithoutHistory).toBeDefined();

		expect(
			mockRecharts.tooltipContent?.({
				active: true,
				payload: [{}],
				label: tickWithoutHistory,
			}),
		).toBeNull();
	});
});
