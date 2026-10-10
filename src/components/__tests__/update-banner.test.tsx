import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UpdateBanner from "../update-banner";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("UpdateBanner", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
  });

  it("shows the available version and opens its release page", async () => {
    const releaseUrl = "https://github.com/kot149/zmk-battery-center/releases/tag/v0.13.0";
    const onDismiss = vi.fn();
    render(<UpdateBanner update={{ version: "0.13.0", releaseUrl }} onDismiss={onDismiss} />);

    const banner = screen.getByRole("button", { name: "Open release v0.13.0" });
    expect(screen.getByText("zmk-battery-center v0.13.0 is available")).toBeTruthy();
    expect(screen.queryByText("View")).toBeNull();
    expect(screen.queryByText("Dismiss")).toBeNull();
    expect(screen.getByText("×")).toBeTruthy();
    await userEvent.setup().click(banner);
    expect(openUrl).toHaveBeenCalledWith(releaseUrl);

    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss update v0.13.0" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledOnce();
  });
});
