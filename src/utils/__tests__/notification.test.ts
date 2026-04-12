import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestNotificationPermission, sendNotification } from "../notification";

const mockIsPermissionGranted = vi.fn();
const mockRequestPermission = vi.fn();
const mockSendNotificationPlugin = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted: () => mockIsPermissionGranted(),
	requestPermission: () => mockRequestPermission(),
	sendNotification: (options: unknown) => mockSendNotificationPlugin(options),
}));

describe("notification utils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsPermissionGranted.mockReset();
		mockRequestPermission.mockReset();
		mockSendNotificationPlugin.mockReset();
	});

	describe("requestNotificationPermission", () => {
		it("returns true when permission is already granted", async () => {
			mockIsPermissionGranted.mockResolvedValue(true);

			await expect(requestNotificationPermission()).resolves.toBe(true);
			expect(mockRequestPermission).not.toHaveBeenCalled();
		});

		it("returns true when permission is granted after request", async () => {
			mockIsPermissionGranted.mockResolvedValue(false);
			mockRequestPermission.mockResolvedValue("granted");

			await expect(requestNotificationPermission()).resolves.toBe(true);
			expect(mockRequestPermission).toHaveBeenCalledTimes(1);
		});

		it("returns false when permission is denied after request", async () => {
			mockIsPermissionGranted.mockResolvedValue(false);
			mockRequestPermission.mockResolvedValue("denied");

			await expect(requestNotificationPermission()).resolves.toBe(false);
		});

		it("propagates permission request errors", async () => {
			mockIsPermissionGranted.mockResolvedValue(false);
			mockRequestPermission.mockRejectedValue(new Error("permission failed"));

			await expect(requestNotificationPermission()).rejects.toThrow("permission failed");
		});
	});

	describe("sendNotification", () => {
		it("returns false when permission cannot be obtained", async () => {
			mockIsPermissionGranted.mockResolvedValue(false);
			mockRequestPermission.mockResolvedValue("denied");

			await expect(sendNotification("Title", "Body")).resolves.toBe(false);
			expect(mockSendNotificationPlugin).not.toHaveBeenCalled();
		});

		it("sends notification and returns true when permission is granted", async () => {
			mockIsPermissionGranted.mockResolvedValue(true);

			await expect(sendNotification("Hello", "World")).resolves.toBe(true);
			expect(mockSendNotificationPlugin).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Hello",
					body: "World",
					channelId: "default",
				}),
			);
		});

		it("propagates plugin send errors", async () => {
			mockIsPermissionGranted.mockResolvedValue(true);
			mockSendNotificationPlugin.mockImplementation(() => {
				throw new Error("send failed");
			});

			await expect(sendNotification("Hello", "World")).rejects.toThrow("send failed");
		});
	});
});
