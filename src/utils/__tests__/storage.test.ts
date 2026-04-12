import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/plugin-os", () => ({
	platform: () => "windows",
}));

describe("storage utils", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it("getDevStorePath invokes once and caches the result", async () => {
		vi.mocked(invoke).mockResolvedValue("D:\\proj\\.dev-data");
		const { getDevStorePath } = await import("../storage");

		await expect(getDevStorePath()).resolves.toBe("D:\\proj\\.dev-data");
		await expect(getDevStorePath()).resolves.toBe("D:\\proj\\.dev-data");

		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("get_dev_store_path");
	});

	it("getDevStorePath returns null and does not retry invoke when it throws", async () => {
		vi.mocked(invoke).mockRejectedValue(new Error("invoke failed"));
		const { getDevStorePath } = await import("../storage");

		await expect(getDevStorePath()).resolves.toBeNull();
		await expect(getDevStorePath()).resolves.toBeNull();

		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("getStorePath joins dev path with Windows separator when dev path is set", async () => {
		vi.mocked(invoke).mockResolvedValue("D:\\proj\\.dev-data");
		const { getStorePath } = await import("../storage");

		await expect(getStorePath("config.json")).resolves.toBe("D:\\proj\\.dev-data\\config.json");
	});

	it("getStorePath returns filename when dev path is unavailable", async () => {
		vi.mocked(invoke).mockResolvedValue(null);
		const { getStorePath } = await import("../storage");

		await expect(getStorePath("devices.json")).resolves.toBe("devices.json");
	});

	it("getStorePath uses POSIX separator on non-windows platforms", async () => {
		vi.resetModules();
		vi.doMock("@tauri-apps/plugin-os", () => ({
			platform: () => "linux",
		}));
		vi.mocked(invoke).mockResolvedValue("/tmp/.dev-data");

		const { getStorePath } = await import("../storage");
		await expect(getStorePath("config.json")).resolves.toBe("/tmp/.dev-data/config.json");
	});
});
