import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { requestNotificationPermission, sendNotification } from "../notification";

const mockIsPermissionGranted = vi.fn();
const mockRequestPermission = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => mockIsPermissionGranted(),
  requestPermission: () => mockRequestPermission(),
}));

describe("notification utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPermissionGranted.mockReset();
    mockRequestPermission.mockReset();
    vi.mocked(invoke).mockReset();
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
      expect(invoke).not.toHaveBeenCalled();
    });

    it("sends notification and returns true when permission is granted", async () => {
      mockIsPermissionGranted.mockResolvedValue(true);

      await expect(sendNotification("Hello", "World")).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledWith("send_notification", {
        title: "Hello",
        body: "World",
      });
    });

    it("propagates backend send errors", async () => {
      mockIsPermissionGranted.mockResolvedValue(true);
      vi.mocked(invoke).mockRejectedValue(new Error("send failed"));

      await expect(sendNotification("Hello", "World")).rejects.toThrow("send failed");
    });
  });
});
