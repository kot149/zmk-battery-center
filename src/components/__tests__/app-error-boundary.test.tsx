import { expect, it, vi } from "vite-plus/test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AppErrorBoundary } from "../app-error-boundary";
import * as transport from "@tauri-apps/plugin-log";

it("reveals recovery instructions with their dimensions after an initial render failure", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(160);
  function Broken(): never {
    throw new Error("render failed");
  }
  try {
    render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Reload this window");
    expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
    expect(transport.error).toHaveBeenCalled();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("window_ready", { width: 360, height: 160 });
    });
  } finally {
    cleanup();
    spy.mockRestore();
    width.mockRestore();
    height.mockRestore();
  }
});
