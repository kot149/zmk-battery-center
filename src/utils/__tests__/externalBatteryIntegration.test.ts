import { describe, expect, it } from "vitest";
import {
	buildExternalBatteryDevices,
	buildRunCatProjection,
	getExternalBatteryPartId,
	toStableExternalKey,
} from "@/utils/externalBatteryIntegration";
import type { RegisteredDevice } from "@/utils/appHelpers";

function device(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
	return {
		id: "kbd-1",
		name: "Corne",
		batteryInfos: [{
			battery_level: 87,
			user_description: null,
			observed_at_unix_ms: 100,
			last_read_succeeded: true,
		}],
		isDisconnected: false,
		isCollapsed: false,
		connectionStatusKnown: true,
		connectionObservedAtUnixMs: 110,
		...overrides,
	};
}

describe("external battery integration", () => {
	it("encodes stable keys from UTF-8 bytes", () => {
		expect(toStableExternalKey("device", "キーボード")).toBe("devicee382ade383bce3839ce383bce38389");
		expect(getExternalBatteryPartId("Peripheral")).toBe("part5065726970686572616c");
		expect(getExternalBatteryPartId(null)).toBe("central");
	});

	it("maps custom display names and preserves ordering", () => {
		const input = [device({
			displayName: "Work keyboard",
			batteryPartLabels: { Central: "Main" },
			batteryInfos: [
				{ battery_level: 0, user_description: null, observed_at_unix_ms: 1, last_read_succeeded: true },
				{ battery_level: 100, user_description: "Peripheral", observed_at_unix_ms: 2, last_read_succeeded: true },
			],
		})];
		const mapped = buildExternalBatteryDevices(input);
		expect(mapped[0]).toMatchObject({
			key: "device6b62642d31",
			displayName: "Work keyboard",
			connectionStatus: "connected",
			connectionObservedAtUnixMs: 110,
		});
		expect(mapped[0].batteryParts).toEqual([
			expect.objectContaining({ id: "central", displayName: "Main", levelPercent: 0, valueStatus: "current" }),
			expect.objectContaining({ id: "part5065726970686572616c", displayName: "Peripheral", levelPercent: 100, valueStatus: "current" }),
		]);
	});

	it.each([
		[false, undefined, "unknown"],
		[true, true, "disconnected"],
		[true, false, "connected"],
	] as const)("maps connection state", (knownMarker, disconnected, expected) => {
		const mapped = buildExternalBatteryDevices([device({
			connectionStatusKnown: knownMarker,
			isDisconnected: disconnected ?? false,
		})]);
		expect(mapped[0].connectionStatus).toBe(expected);
		expect(mapped[0].connectionObservedAtUnixMs).toBe(expected === "unknown" ? null : 110);
	});

	it("distinguishes current, stale, and unavailable values", () => {
		const mapped = buildExternalBatteryDevices([device({
			batteryInfos: [
				{ battery_level: 50, user_description: null, last_read_succeeded: true, observed_at_unix_ms: 1 },
				{ battery_level: 60, user_description: "Left", last_read_succeeded: false, observed_at_unix_ms: 2 },
				{ battery_level: null, user_description: "Right", last_read_succeeded: false, observed_at_unix_ms: null },
				{ battery_level: 101, user_description: "Invalid", last_read_succeeded: true, observed_at_unix_ms: 3 },
			],
		})]);
		expect(mapped[0].batteryParts.map(part => part.valueStatus)).toEqual([
			"current", "stale", "unavailable", "unavailable",
		]);
	});

	it("marks numeric levels stale while disconnected or unknown", () => {
		for (const overrides of [{ isDisconnected: true }, { connectionStatusKnown: false }]) {
			const mapped = buildExternalBatteryDevices([device(overrides)]);
			expect(mapped[0].batteryParts[0].valueStatus).toBe("stale");
		}
	});

	it("builds RunCat metrics without generating a timestamp", () => {
		const projection = buildRunCatProjection([device({
			batteryInfos: [
				{ battery_level: 87, user_description: null, last_read_succeeded: true },
				{ battery_level: 64, user_description: "Peripheral", last_read_succeeded: false },
			],
		})]);
		expect(projection).toEqual({
			title: "ZMK Battery Center",
			symbol: "battery.100percent",
			metricsBarValue: "87% · 64%*",
			metrics: [
				{ title: "Corne / Connection", formattedValue: "Connected" },
				{ title: "Corne / Central", formattedValue: "87%", normalizedValue: 0.87 },
				{ title: "Corne / Peripheral", formattedValue: "64% (stale)", normalizedValue: 0.64 },
			],
		});
	});

	it("omits normalizedValue and returns N/A for unavailable values", () => {
		const projection = buildRunCatProjection([device({
			batteryInfos: [{ battery_level: null, user_description: null, last_read_succeeded: false }],
		})]);
		expect(projection.metrics[1]).toEqual({ title: "Corne / Central", formattedValue: "N/A" });
		expect(projection.metricsBarValue).toBe("N/A");
	});

	it("does not mutate the source devices", () => {
		const input = [device()];
		const before = structuredClone(input);
		buildExternalBatteryDevices(input);
		buildRunCatProjection(input);
		expect(input).toEqual(before);
	});
});
