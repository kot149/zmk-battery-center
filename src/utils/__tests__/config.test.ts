import { beforeEach, describe, expect, it, vi } from "vitest";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

const {
	mockStore,
	mockLoad,
	mockGetStorePath,
	mockRequestNotificationPermission,
	mockLoggerInfo,
	mockLoggerWarn,
} = vi.hoisted(() => {
	const store = {
		get: vi.fn(),
		set: vi.fn(async () => undefined),
	};
	return {
		mockStore: store,
		mockLoad: vi.fn(async () => store),
		mockGetStorePath: vi.fn(async () => "config.json"),
		mockRequestNotificationPermission: vi.fn(async () => true),
		mockLoggerInfo: vi.fn(async () => undefined),
		mockLoggerWarn: vi.fn(async () => undefined),
	};
});

vi.mock("@/utils/storage", () => ({
	load: mockLoad,
	getStorePath: mockGetStorePath,
}));

vi.mock("@/utils/notification", () => ({
	requestNotificationPermission: mockRequestNotificationPermission,
}));

vi.mock("@/utils/log", () => ({
	logger: {
		info: mockLoggerInfo,
		warn: mockLoggerWarn,
	},
}));

describe("config utils", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mockStore.set.mockResolvedValue(undefined);
		mockRequestNotificationPermission.mockResolvedValue(true);
	});

	it("loadSavedConfig merges defaults with stored values", async () => {
		mockStore.get.mockResolvedValue({
			autoStart: true,
			fetchInterval: 60_000,
			pushNotificationWhen: {
				low_battery: false,
				disconnected: true,
				connected: false,
			},
		});

		const { defaultConfig, loadSavedConfig } = await import("../config");
		const loaded = await loadSavedConfig();

		expect(mockGetStorePath).toHaveBeenCalledWith("config.json");
		expect(mockStore.get).toHaveBeenCalledWith("config");
		expect(loaded).toEqual({
			...defaultConfig,
			autoStart: true,
			fetchInterval: 60_000,
			pushNotificationWhen: {
				...defaultConfig.pushNotificationWhen,
				low_battery: false,
				disconnected: true,
				connected: false,
			},
		});
	});

	it.each([
		{
			name: "enables autostart when requested and currently disabled",
			currentAutostart: false,
			nextAutostart: true,
			expectedEnableCalls: 1,
			expectedDisableCalls: 0,
		},
		{
			name: "disables autostart when requested and currently enabled",
			currentAutostart: true,
			nextAutostart: false,
			expectedEnableCalls: 0,
			expectedDisableCalls: 1,
		},
		{
			name: "keeps autostart unchanged when requested state matches current",
			currentAutostart: true,
			nextAutostart: true,
			expectedEnableCalls: 0,
			expectedDisableCalls: 0,
		},
	])(
		"setConfig autostart: $name",
		async ({ currentAutostart, nextAutostart, expectedEnableCalls, expectedDisableCalls }) => {
			vi.mocked(isEnabled).mockResolvedValue(currentAutostart);

			const { defaultConfig, setConfig } = await import("../config");
			await setConfig({
				...defaultConfig,
				autoStart: nextAutostart,
				pushNotification: false,
			});

			expect(mockStore.set).toHaveBeenCalledWith(
				"config",
				expect.objectContaining({ autoStart: nextAutostart, pushNotification: false }),
			);
			expect(enable).toHaveBeenCalledTimes(expectedEnableCalls);
			expect(disable).toHaveBeenCalledTimes(expectedDisableCalls);
			expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
		},
	);

	it("loadSavedConfig returns defaults when no saved config exists", async () => {
		mockStore.get.mockResolvedValue(undefined);

		const { defaultConfig, loadSavedConfig } = await import("../config");
		const loaded = await loadSavedConfig();

		expect(loaded).toEqual(defaultConfig);
	});

	it("setConfig propagates store write errors", async () => {
		const error = new Error("store write failed");
		mockStore.set.mockRejectedValue(error);
		vi.mocked(isEnabled).mockResolvedValue(false);

		const { defaultConfig, setConfig } = await import("../config");

		await expect(
			setConfig({ ...defaultConfig, autoStart: true, pushNotification: false }),
		).rejects.toThrow("store write failed");
		expect(enable).not.toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
	});

	it("setConfig requests notification permission when enabled and logs grant", async () => {
		vi.mocked(isEnabled).mockResolvedValue(false);
		mockRequestNotificationPermission.mockResolvedValue(true);

		const { defaultConfig, setConfig } = await import("../config");
		await setConfig({ ...defaultConfig, autoStart: false, pushNotification: true });

		expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1);
		expect(mockLoggerInfo).toHaveBeenCalledWith("Notification permission granted");
		expect(mockLoggerWarn).not.toHaveBeenCalledWith("Notification permission not granted");
	});

	it("setConfig requests notification permission when enabled and logs warning if denied", async () => {
		vi.mocked(isEnabled).mockResolvedValue(false);
		mockRequestNotificationPermission.mockResolvedValue(false);

		const { defaultConfig, setConfig } = await import("../config");
		await setConfig({ ...defaultConfig, autoStart: false, pushNotification: true });

		expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1);
		expect(mockLoggerWarn).toHaveBeenCalledWith("Notification permission not granted");
		expect(mockLoggerInfo).not.toHaveBeenCalledWith("Notification permission granted");
	});

	it("setConfig enables autostart and requests notification permission when both are enabled", async () => {
		vi.mocked(isEnabled).mockResolvedValue(false);
		mockRequestNotificationPermission.mockResolvedValue(true);

		const { defaultConfig, setConfig } = await import("../config");
		await setConfig({ ...defaultConfig, autoStart: true, pushNotification: true });

		expect(enable).toHaveBeenCalledTimes(1);
		expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1);
		expect(mockLoggerInfo).toHaveBeenCalledWith("Notification permission granted");
	});

	it("clampBatteryThreshold clamps and rounds out-of-range values", async () => {
		const { clampBatteryThreshold } = await import("../config");
		expect(clampBatteryThreshold(0, 20)).toBe(1);
		expect(clampBatteryThreshold(100, 95)).toBe(99);
		expect(clampBatteryThreshold(50.6, 20)).toBe(51);
		expect(clampBatteryThreshold(Number.NaN, 30)).toBe(30);
		expect(clampBatteryThreshold(Number.POSITIVE_INFINITY, 30)).toBe(30);
	});

	it("clampBatteryThreshold honors custom min/max bounds", async () => {
		const { clampBatteryThreshold } = await import("../config");
		expect(clampBatteryThreshold(50, 20, { max: 40 })).toBe(40);
		expect(clampBatteryThreshold(10, 80, { min: 50 })).toBe(50);
		expect(clampBatteryThreshold(60, 20, { min: 30, max: 70 })).toBe(60);
	});

	it("loadSavedConfig clamps stored thresholds and falls back to defaults", async () => {
		mockStore.get.mockResolvedValue({
			lowBatteryThreshold: 0,
			highBatteryThreshold: 250,
		});

		const { loadSavedConfig } = await import("../config");
		const loaded = await loadSavedConfig();

		expect(loaded.lowBatteryThreshold).toBe(1);
		expect(loaded.highBatteryThreshold).toBe(99);
	});

	it("loadSavedConfig falls back to defaults when stored thresholds overlap", async () => {
		mockStore.get.mockResolvedValue({
			lowBatteryThreshold: 80,
			highBatteryThreshold: 20,
		});

		const { loadSavedConfig, defaultConfig } = await import("../config");
		const loaded = await loadSavedConfig();

		expect(loaded.lowBatteryThreshold).toBe(defaultConfig.lowBatteryThreshold);
		expect(loaded.highBatteryThreshold).toBe(defaultConfig.highBatteryThreshold);
	});

	it("loadSavedConfig deep-merges pushNotificationWhen so missing keys keep defaults", async () => {
		mockStore.get.mockResolvedValue({
			pushNotificationWhen: {
				low_battery: false,
				connected: false,
				disconnected: false,
			},
		});

		const { loadSavedConfig, defaultConfig } = await import("../config");
		const loaded = await loadSavedConfig();

		expect(loaded.pushNotificationWhen.low_battery).toBe(false);
		expect(loaded.pushNotificationWhen.high_battery).toBe(defaultConfig.pushNotificationWhen.high_battery);
		expect(loaded.pushNotificationWhen.connected).toBe(false);
		expect(loaded.pushNotificationWhen.disconnected).toBe(false);
	});

	it("loadSavedConfig reuses config store so load is only invoked once", async () => {
		mockStore.get.mockResolvedValue(undefined);

		const { loadSavedConfig } = await import("../config");
		await loadSavedConfig();
		await loadSavedConfig();

		expect(mockLoad).toHaveBeenCalledTimes(1);
		expect(mockGetStorePath).toHaveBeenCalledTimes(1);
	});
});
