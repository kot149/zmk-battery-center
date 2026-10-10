import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissUpdateVersion, isUpdateDismissed } from "../update";

const mocks = vi.hoisted(() => {
  return {
    invoke: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("update dismissal", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("reads dismissal through the monitor service", async () => {
    mocks.invoke.mockResolvedValue(true);

    await expect(isUpdateDismissed("0.13.0")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("monitor_is_update_dismissed", {
      version: "0.13.0",
    });
  });

  it("saves dismissal through the monitor service", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await dismissUpdateVersion("0.13.0");
    expect(mocks.invoke).toHaveBeenCalledWith("monitor_dismiss_update", {
      version: "0.13.0",
    });
  });
});
