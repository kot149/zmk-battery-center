import { beforeEach, describe, expect, it, vi } from "vitest";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

const { mockStore, mockLoad, mockGetStorePath, mockRequestNotificationPermission } = vi.hoisted(() => {
	const store = {
		get: vi.fn(),
		set: vi.fn(async () => undefined),
	};
	return {
		mockStore: store,
		mockLoad: vi.fn(async () => store),
		mockGetStorePath: vi.fn(async () => "config.json"),
		mockRequestNotificationPermission: vi.fn(async () => true),
	};
});

vi.mock("@/utils/storage", () => ({
	load: mockLoad,
	getStorePath: mockGetStorePath,
}));

vi.mock("./notification", () => ({
	requestNotificationPermission: mockRequestNotificationPermission,
}));

vi.mock("./log", () => ({
	logger: {
		info: vi.fn(async () => undefined),
		warn: vi.fn(async () => undefined),
	},
}));

describe("config utils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStore.get.mockReset();
		mockStore.set.mockReset();
		mockStore.set.mockResolvedValue(undefined);
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

		const { defaultConfig, loadSavedConfig } = await import("./config");
		const loaded = await loadSavedConfig();

		expect(mockGetStorePath).toHaveBeenCalledWith("config.json");
		expect(mockStore.get).toHaveBeenCalledWith("config");
		expect(loaded).toEqual({
			...defaultConfig,
			autoStart: true,
			fetchInterval: 60_000,
			pushNotificationWhen: {
				low_battery: false,
				disconnected: true,
				connected: false,
			},
		});
	});

	it("setConfig enables autostart when requested and disabled", async () => {
		(isEnabled as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const { defaultConfig, setConfig } = await import("./config");
		await setConfig({ ...defaultConfig, autoStart: true, pushNotification: false });

		expect(mockStore.set).toHaveBeenCalledWith(
			"config",
			expect.objectContaining({ autoStart: true, pushNotification: false }),
		);
		expect(enable).toHaveBeenCalledTimes(1);
		expect(disable).not.toHaveBeenCalled();
		expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
	});

	it("setConfig disables autostart when requested and enabled", async () => {
		(isEnabled as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

		const { defaultConfig, setConfig } = await import("./config");
		await setConfig({ ...defaultConfig, autoStart: false, pushNotification: true });

		expect(disable).toHaveBeenCalledTimes(1);
		expect(enable).not.toHaveBeenCalled();
		expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1);
	});
});
