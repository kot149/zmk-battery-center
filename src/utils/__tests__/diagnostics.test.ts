import { expect, it, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { applyLogLevel, setLogLevel } from "../diagnostics";
import { logger } from "../log";

it("ignores stale state and does not change level after a failed save", async () => {
  applyLogLevel({ level: "info", generation: 100 });
  applyLogLevel({ level: "debug", generation: 99 });
  expect(logger.isEnabled("debug")).toBe(false);
  expect(logger.isEnabled("info")).toBe(true);
  vi.mocked(invoke).mockRejectedValueOnce(new Error("save failed"));
  await expect(setLogLevel("debug")).rejects.toThrow("save failed");
  expect(logger.isEnabled("debug")).toBe(false);
});
