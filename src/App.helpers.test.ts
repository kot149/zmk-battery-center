import { describe, expect, it } from "vitest";
import { mergeBatteryInfos, normalizeLoadedDevices, upsertBatteryInfo } from "./utils/appHelpers";

describe("App helpers", () => {
	describe("upsertBatteryInfo", () => {
		it("appends when user description is not present", () => {
			const prev = [{ battery_level: 80, user_description: "Left" }];
			const nextInfo = { battery_level: 65, user_description: "Right" };

			expect(upsertBatteryInfo(prev, nextInfo)).toEqual([
				{ battery_level: 80, user_description: "Left" },
				{ battery_level: 65, user_description: "Right" },
			]);
		});

		it("keeps existing battery level when incoming level is null", () => {
			const prev = [{ battery_level: 42, user_description: "Central" }];
			const nextInfo = { battery_level: null, user_description: "Central" };

			expect(upsertBatteryInfo(prev, nextInfo)).toEqual([
				{ battery_level: 42, user_description: "Central" },
			]);
		});
	});

	describe("mergeBatteryInfos", () => {
		it("replaces entries and preserves previous level for null payload", () => {
			const prev = [
				{ battery_level: 30, user_description: "Left" },
				{ battery_level: 50, user_description: "Right" },
			];
			const next = [
				{ battery_level: null, user_description: "Left" },
				{ battery_level: 44, user_description: "Right" },
				{ battery_level: 71, user_description: "Central" },
			];

			expect(mergeBatteryInfos(prev, next)).toEqual([
				{ battery_level: 30, user_description: "Left" },
				{ battery_level: 44, user_description: "Right" },
				{ battery_level: 71, user_description: "Central" },
			]);
		});
	});

	describe("normalizeLoadedDevices", () => {
		it("normalizes legacy user_descriptor and DeviceId wrapper", () => {
			const raw = [
				{
					id: 'DeviceId("abc-123")',
					name: 'DeviceId("My Keyboard")',
					isDisconnected: true,
					batteryInfos: [
						{ battery_level: 88, user_descriptor: "Left" },
						{ battery_level: "unknown", user_description: "Right" },
					],
				},
			];

			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "abc-123",
					name: "My Keyboard",
					isDisconnected: true,
					batteryInfos: [
						{ battery_level: 88, user_description: "Left" },
						{ battery_level: null, user_description: "Right" },
					],
				},
			]);
		});

		it("returns empty array for non-array input", () => {
			expect(normalizeLoadedDevices({ invalid: true })).toEqual([]);
		});
	});
});
