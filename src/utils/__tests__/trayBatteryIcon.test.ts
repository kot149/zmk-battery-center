import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { syncTrayBatteryIcon, trayBatteryPayloadFromPrimaryDevice } from "../trayBatteryIcon";
import { defaultConfig, TrayIconComponent } from "@/utils/config";
import type { RegisteredDevice } from "@/utils/appHelpers";
import type { BatteryInfo } from "@/utils/ble";

const mockedInvoke = vi.mocked(invoke);

function device(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
	return {
		id: "kbd-1",
		name: "MockBoard One",
		batteryInfos: [],
		isDisconnected: false,
		isCollapsed: false,
		...overrides,
	};
}

function info(battery_level: number | null, user_description: string | null): BatteryInfo {
	return { battery_level, user_description };
}

describe("trayBatteryPayloadFromPrimaryDevice", () => {
	it("disables the tray payload for an empty device list", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([]);
		expect(payload.enabled).toBe(false);
		expect(payload.rowCount).toBe(1);
		expect(payload.centralPercent).toBeNull();
		expect(payload.peripheralPercent).toBeNull();
		expect(payload.centralLabel).toBeNull();
		expect(payload.peripheralLabel).toBeNull();
		expect(payload.disconnected).toBe(false);
	});

	it("keeps a disconnected device with no infos enabled with a default label", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ isDisconnected: true }),
		]);
		expect(payload.enabled).toBe(true);
		expect(payload.centralPercent).toBeNull();
		expect(payload.disconnected).toBe(true);
		expect(payload.centralLabel).toBe("C");
	});

	it("uses the custom Central label for a device with no infos", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryPartLabels: { Central: "left" } }),
		]);
		expect(payload.centralLabel).toBe("L");
	});

	it("maps a single info without description to one row labeled C", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(85, null)] }),
		]);
		expect(payload.rowCount).toBe(1);
		expect(payload.centralPercent).toBe(85);
		expect(payload.centralLabel).toBe("C");
		expect(payload.peripheralPercent).toBeNull();
	});

	it("uppercases a single-character description", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(85, "x")] }),
		]);
		expect(payload.centralLabel).toBe("X");
	});

	it("maps two Central/Peripheral infos to two rows labeled C and P", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(90, "Central"), info(72, "Peripheral")] }),
		]);
		expect(payload.rowCount).toBe(2);
		expect(payload.centralPercent).toBe(90);
		expect(payload.peripheralPercent).toBe(72);
		expect(payload.centralLabel).toBe("C");
		expect(payload.peripheralLabel).toBe("P");
	});

	it("uses first-char labels for non-special descriptions", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(90, "left"), info(72, "right")] }),
		]);
		expect(payload.centralLabel).toBe("L");
		expect(payload.peripheralLabel).toBe("R");
	});

	it("prefers custom labels over descriptions", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({
				batteryInfos: [info(90, "Central"), info(72, "Peripheral")],
				batteryPartLabels: { Central: "aa", Peripheral: "bb" },
			}),
		]);
		expect(payload.centralLabel).toBe("A");
		expect(payload.peripheralLabel).toBe("B");
	});

	it("emits uppercase single-character glyphs for every label source", () => {
		const cases = [
			{ registeredDevice: device(), expectedLabels: ["C", null] },
			{ registeredDevice: device({ batteryInfos: [info(90, "central")] }), expectedLabels: ["C", null] },
			{ registeredDevice: device({ batteryInfos: [info(90, "peripheral")] }), expectedLabels: ["P", null] },
			{ registeredDevice: device({ batteryInfos: [info(90, "Left half")] }), expectedLabels: ["L", null] },
			{ registeredDevice: device({ batteryInfos: [info(90, "x")] }), expectedLabels: ["X", null] },
			{
				registeredDevice: device({
					batteryInfos: [info(90, "Central")],
					batteryPartLabels: { Central: "dongle" },
				}),
				expectedLabels: ["D", null],
			},
		];

		for (const { registeredDevice, expectedLabels } of cases) {
			const payload = trayBatteryPayloadFromPrimaryDevice([registeredDevice]);
			const labels = [payload.centralLabel, payload.peripheralLabel];
			expect(labels).toEqual(expectedLabels);

			for (const label of labels) {
				if (label !== null) {
					expect(label).toHaveLength(1);
					expect(label).toBe(label.toUpperCase());
				}
			}
		}
	});

	it("keeps a null battery level as a null percent", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(null, "Central"), info(72, "Peripheral")] }),
		]);
		expect(payload.centralPercent).toBeNull();
		expect(payload.peripheralPercent).toBe(72);
	});

	it("renders only the first device in the list", () => {
		const payload = trayBatteryPayloadFromPrimaryDevice([
			device({ batteryInfos: [info(90, "Central")] }),
			device({ id: "kbd-2", batteryInfos: [info(10, "Central")] }),
		]);
		expect(payload.centralPercent).toBe(90);
	});
});

describe("syncTrayBatteryIcon", () => {
	beforeEach(() => {
		mockedInvoke.mockReset();
		mockedInvoke.mockResolvedValue(undefined);
	});

	it("forwards the payload with the given components", async () => {
		await syncTrayBatteryIcon([device({ batteryInfos: [info(85, null)] })], [TrayIconComponent.BatteryPercent]);

		expect(invoke).toHaveBeenCalledWith("update_tray_battery_icon", {
			payload: expect.objectContaining({
				enabled: true,
				centralPercent: 85,
				components: [TrayIconComponent.BatteryPercent],
			}),
		});
	});

	it("falls back to the first default component when components is empty", async () => {
		await syncTrayBatteryIcon([device()], []);

		expect(invoke).toHaveBeenCalledWith("update_tray_battery_icon", {
			payload: expect.objectContaining({
				components: [defaultConfig.trayIconComponents[0]],
			}),
		});
	});
});
