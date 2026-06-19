import { describe, expect, it } from "vitest";
import { mapIsHighBattery, mapIsLowBattery, mergeBatteryInfos, normalizeLoadedDevices, upsertBatteryInfo, getRegisteredDeviceDisplayName } from "../appHelpers";

describe("App helpers", () => {
	describe("getRegisteredDeviceDisplayName", () => {
		it("prefers non-empty displayName", () => {
			expect(getRegisteredDeviceDisplayName({ name: "BLE", displayName: "Desk" })).toBe("Desk");
		});

		it("falls back to name when displayName absent or blank", () => {
			expect(getRegisteredDeviceDisplayName({ name: "BLE" })).toBe("BLE");
			expect(getRegisteredDeviceDisplayName({ name: "BLE", displayName: "  " })).toBe("BLE");
		});
	});
	describe("mapIsLowBattery", () => {
		it("marks levels at or below threshold as low", () => {
			const infos = [
				{ battery_level: 30, user_description: "Left" },
				{ battery_level: 20, user_description: "Right" },
				{ battery_level: 19, user_description: "Central" },
				{ battery_level: null, user_description: "Aux" },
			];
			expect(mapIsLowBattery(infos, 20)).toEqual([false, true, true, false]);
		});

		it("respects a custom threshold", () => {
			const infos = [{ battery_level: 30, user_description: null }];
			expect(mapIsLowBattery(infos, 50)).toEqual([true]);
		});
	});

	describe("mapIsHighBattery", () => {
		it("marks levels at or above threshold as high", () => {
			const infos = [
				{ battery_level: 94, user_description: "Left" },
				{ battery_level: 95, user_description: "Right" },
				{ battery_level: 100, user_description: "Central" },
				{ battery_level: null, user_description: "Aux" },
			];
			expect(mapIsHighBattery(infos, 95)).toEqual([false, true, true, false]);
		});
	});

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

		it("overwrites existing entry when incoming level is non-null", () => {
			const prev = [{ battery_level: 42, user_description: "Central" }];
			const nextInfo = { battery_level: 99, user_description: "Central" };

			expect(upsertBatteryInfo(prev, nextInfo)).toEqual([
				{ battery_level: 99, user_description: "Central" },
			]);
		});

		it("matches entries when user_description is null on both sides", () => {
			const prev = [{ battery_level: 10, user_description: null }];
			const nextInfo = { battery_level: 55, user_description: null };

			expect(upsertBatteryInfo(prev, nextInfo)).toEqual([{ battery_level: 55, user_description: null }]);
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

		it("returns empty array when next is empty", () => {
			const prev = [{ battery_level: 30, user_description: "Left" }];
			expect(mergeBatteryInfos(prev, [])).toEqual([]);
		});

		it("passes through next when prev is empty and levels are null", () => {
			const next = [
				{ battery_level: null, user_description: "Left" },
				{ battery_level: 44, user_description: "Right" },
			];
			expect(mergeBatteryInfos([], next)).toEqual([
				{ battery_level: null, user_description: "Left" },
				{ battery_level: 44, user_description: "Right" },
			]);
		});

		it("keeps null battery level when no matching previous entry exists", () => {
			const prev = [{ battery_level: 30, user_description: "Left" }];
			const next = [{ battery_level: null, user_description: "Right" }];
			expect(mergeBatteryInfos(prev, next)).toEqual([
				{ battery_level: null, user_description: "Right" },
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
					isCollapsed: false,
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

		it("uses empty batteryInfos when field is missing", () => {
			const raw = [{ id: "dev-1", name: "Keyboard", isDisconnected: false }];
			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "dev-1",
					name: "Keyboard",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [],
				},
			]);
		});

		it("returns empty id and name strings when not strings", () => {
			const raw = [{ id: 123, name: null, batteryInfos: [] }];
			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "",
					name: "",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [],
				},
			]);
		});

		it("keeps plain ids without DeviceId wrapper", () => {
			const raw = [
				{
					id: "plain-id",
					name: "Plain Name",
					isDisconnected: true,
					batteryInfos: [],
				},
			];
			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "plain-id",
					name: "Plain Name",
					isDisconnected: true,
					isCollapsed: false,
					batteryInfos: [],
				},
			]);
		});

		it("sets isDisconnected false when undefined or false", () => {
			expect(
				normalizeLoadedDevices([
					{ id: "a", name: "A", batteryInfos: [], isDisconnected: false },
					{ id: "b", name: "B", batteryInfos: [] },
				]),
			).toEqual([
				{ id: "a", name: "A", isDisconnected: false, isCollapsed: false, batteryInfos: [] },
				{ id: "b", name: "B", isDisconnected: false, isCollapsed: false, batteryInfos: [] },
			]);
		});

		it("normalizes non-string user description fields to null", () => {
			const raw = [
				{
					id: "dev-1",
					name: "Keyboard",
					batteryInfos: [
						{ battery_level: 20, user_description: 123 },
						{ battery_level: 25, user_descriptor: { side: "left" } },
					],
				},
			];

			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "dev-1",
					name: "Keyboard",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [
						{ battery_level: 20, user_description: null },
						{ battery_level: 25, user_description: null },
					],
				},
			]);
		});

		it("loads optional displayName when non-empty after trim", () => {
			const raw = [
				{
					id: "dev-1",
					name: "Keyboard",
					batteryInfos: [],
					displayName: "  Living room  ",
				},
			];

			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "dev-1",
					name: "Keyboard",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [],
					displayName: "Living room",
				},
			]);
		});

		it("drops empty displayName values", () => {
			const raw = [
				{
					id: "dev-1",
					name: "Keyboard",
					batteryInfos: [],
					displayName: "   ",
				},
			];

			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "dev-1",
					name: "Keyboard",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [],
				},
			]);
		});

		it("loads batteryPartLabels as a string record and drops empty values", () => {
			const raw = [
				{
					id: "dev-1",
					name: "Keyboard",
					batteryInfos: [],
					batteryPartLabels: { Central: "  Left  ", Peripheral: " ", Extra: 99 as unknown as string },
				},
			];

			expect(normalizeLoadedDevices(raw)).toEqual([
				{
					id: "dev-1",
					name: "Keyboard",
					isDisconnected: false,
					isCollapsed: false,
					batteryInfos: [],
					batteryPartLabels: { Central: "Left" },
				},
			]);
		});
	});
});
