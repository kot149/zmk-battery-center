import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { appendBatteryHistory, readBatteryHistory } from "./batteryHistory";

describe("batteryHistory utils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("appendBatteryHistory invokes command with expected payload", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-03T04:05:06.000Z"));
		(invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		await appendBatteryHistory("Keyboard", "dev-1", "Left", 77);

		expect(invoke).toHaveBeenCalledWith("append_battery_history", {
			deviceName: "Keyboard",
			bleId: "dev-1",
			timestamp: "2026-02-03T04:05:06.000Z",
			userDescription: "Left",
			batteryLevel: 77,
		});
		vi.useRealTimers();
	});

	it("readBatteryHistory invokes command with requested ids", async () => {
		const mockedHistory = [
			{
				timestamp: "2026-01-01T00:00:00.000Z",
				user_description: "Central",
				battery_level: 90,
			},
		];
		(invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(mockedHistory);

		const result = await readBatteryHistory("Keyboard", "dev-1");

		expect(invoke).toHaveBeenCalledWith("read_battery_history", {
			deviceName: "Keyboard",
			bleId: "dev-1",
		});
		expect(result).toEqual(mockedHistory);
	});
});
