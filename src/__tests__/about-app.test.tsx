import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import AboutApp from "../about-app";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.0.0-test"),
}));

const licensesData = {
  js_licenses: [
    {
      name: "test-package",
      version: "1.0.0",
      license: "MIT",
      repository: "https://example.com/repo",
      publisher: "tester",
      licenseText: "license body text",
    },
  ],
  cargo_licenses: [],
};

describe("AboutApp license items", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(licensesData);
    vi.mocked(openUrl).mockResolvedValue(undefined);
  });

  async function renderAbout() {
    // Flush the suspended licenses promise so queries below run synchronously.
    await act(async () => {
      render(<AboutApp />);
    });
  }

  it("does not hijack Enter on the repository link", async () => {
    await renderAbout();
    const link = screen.getByRole("link", { name: "https://example.com/repo" });

    // The header keydown handler must not prevent the link's native activation.
    const notPrevented = fireEvent.keyDown(link, { key: "Enter" });
    expect(notPrevented).toBe(true);
    expect(screen.queryByText("license body text")).toBeNull();
  });

  it("toggles the license body with Enter on the header", async () => {
    await renderAbout();
    const header = screen.getByRole("button", { name: /test-package/ });

    fireEvent.keyDown(header, { key: "Enter" });
    expect(screen.queryByText("license body text")).not.toBeNull();

    fireEvent.keyDown(header, { key: " " });
    expect(screen.queryByText("license body text")).toBeNull();
  });

  it("opens the repository link on click", async () => {
    const user = userEvent.setup();
    await renderAbout();
    const link = screen.getByRole("link", { name: "https://example.com/repo" });

    await user.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/repo");
  });
});
