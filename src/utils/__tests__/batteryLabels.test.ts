import { describe, expect, it } from "vitest";
import {
	batteryPartLabelStorageKey,
	defaultBatteryPartDisplayName,
	getBatteryPartDisplayName,
} from "../batteryLabels";

describe("batteryLabels", () => {
	it("uses Central as the storage key for null user_description", () => {
		expect(batteryPartLabelStorageKey(null)).toBe("Central");
		expect(batteryPartLabelStorageKey(undefined)).toBe("Central");
	});

	it("preserves explicit user_description in the storage key", () => {
		expect(batteryPartLabelStorageKey("Peripheral")).toBe("Peripheral");
	});

	it("getBatteryPartDisplayName uses custom label when set", () => {
		const labels = { Central: "Left half", Peripheral: "Right" };
		expect(getBatteryPartDisplayName(labels, null)).toBe("Left half");
		expect(getBatteryPartDisplayName(labels, "Peripheral")).toBe("Right");
	});

	it("getBatteryPartDisplayName falls back to the default name", () => {
		expect(getBatteryPartDisplayName(undefined, null)).toBe("Central");
		expect(getBatteryPartDisplayName({}, "Peripheral")).toBe("Peripheral");
	});

	it("defaultBatteryPartDisplayName matches prior UI fallback", () => {
		expect(defaultBatteryPartDisplayName(null)).toBe("Central");
		expect(defaultBatteryPartDisplayName("Peripheral")).toBe("Peripheral");
	});
});
