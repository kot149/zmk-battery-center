import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/app";
import { ThemeProvider } from "@/providers/theme-provider";
import { defaultConfig, type Config } from "@/utils/config";
import type { RegisteredDevice } from "@/utils/app-helpers";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  resizeWindowToContent: vi.fn(async () => undefined),
  moveWindowToTrayCenter: vi.fn(async () => undefined),
  listBatteryDevices: vi.fn(async () => [{ id: "kbd-2", name: "Available Keyboard" }]),
  context: {
    config: null as unknown as Config,
    setConfig: vi.fn(),
    isConfigLoaded: true,
    isMonitorHydrationSettled: true,
    monitorError: null as string | null,
    registeredDevices: [] as RegisteredDevice[],
    isDeviceLoaded: true,
    addDevice: vi.fn(async () => undefined),
    removeDevice: vi.fn(async () => undefined),
    setDeviceDisplayName: vi.fn(async () => undefined),
    setPartLabel: vi.fn(async () => undefined),
    setDeviceCollapsed: vi.fn(async () => undefined),
    reorderDevices: vi.fn(async () => undefined),
    reloadMonitor: vi.fn(async () => undefined),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "windows",
}));

vi.mock("@/utils/ble", () => ({
  listBatteryDevices: () => mocks.listBatteryDevices(),
}));

vi.mock("@/providers/config-provider", () => ({
  useConfigContext: () => mocks.context,
}));

vi.mock("@/hooks/use-window-events", () => ({
  useWindowEvents: vi.fn(),
}));

vi.mock("@/utils/window", () => ({
  resizeWindowToContent: () => mocks.resizeWindowToContent(),
  moveWindowToTrayCenter: () => mocks.moveWindowToTrayCenter(),
}));

function device(id: string, name: string): RegisteredDevice {
  return {
    id,
    name,
    batteryInfos: [{ battery_level: 87, user_description: "Central" }],
    isDisconnected: false,
    isCollapsed: false,
  };
}

function renderApp() {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    mocks.context.config = { ...defaultConfig };
    mocks.context.setConfig.mockReset();
    mocks.context.isConfigLoaded = true;
    mocks.context.isMonitorHydrationSettled = true;
    mocks.context.monitorError = null;
    mocks.context.registeredDevices = [];
    mocks.context.isDeviceLoaded = true;
    mocks.context.addDevice.mockReset();
    mocks.context.addDevice.mockResolvedValue(undefined);
    mocks.context.removeDevice.mockReset();
    mocks.context.removeDevice.mockResolvedValue(undefined);
    mocks.context.setDeviceDisplayName.mockReset();
    mocks.context.setDeviceDisplayName.mockResolvedValue(undefined);
    mocks.context.setPartLabel.mockReset();
    mocks.context.setPartLabel.mockResolvedValue(undefined);
    mocks.context.setDeviceCollapsed.mockReset();
    mocks.context.setDeviceCollapsed.mockResolvedValue(undefined);
    mocks.context.reorderDevices.mockReset();
    mocks.context.reorderDevices.mockResolvedValue(undefined);
    mocks.context.reloadMonitor.mockReset();
    mocks.context.reloadMonitor.mockResolvedValue(undefined);
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.resizeWindowToContent.mockClear();
    mocks.moveWindowToTrayCenter.mockClear();
    mocks.listBatteryDevices.mockReset();
    mocks.listBatteryDevices.mockResolvedValue([{ id: "kbd-2", name: "Available Keyboard" }]);
  });

  it("renders canonical devices and signals readiness after hydration", async () => {
    mocks.context.registeredDevices = [device("kbd-1", "Keyboard")];
    renderApp();

    expect(screen.getByText("Keyboard")).toBeTruthy();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("window_ready", { width: 0, height: 0 }),
    );
    expect(mocks.resizeWindowToContent).not.toHaveBeenCalled();
    expect(mocks.moveWindowToTrayCenter).not.toHaveBeenCalled();
  });

  it("reveals the window when monitor hydration fails", async () => {
    mocks.context.isConfigLoaded = false;
    mocks.context.isDeviceLoaded = false;
    mocks.context.isMonitorHydrationSettled = true;
    mocks.context.monitorError = "Failed to load monitor state: backend unavailable";

    renderApp();

    expect(screen.getByRole("alert").textContent).toContain("backend unavailable");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("window_ready", { width: 0, height: 0 }),
    );
  });

  it("sends measured content dimensions with readiness", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
    try {
      renderApp();
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith("window_ready", { width: 360, height: 240 }),
      );
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it("waits for hydration before signaling readiness", async () => {
    mocks.context.isMonitorHydrationSettled = false;
    renderApp();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("resizes subsequent layouts without revealing the window again", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(mocks.resizeWindowToContent).toHaveBeenCalled());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "window_ready")).toHaveLength(
      1,
    );
  });

  it("retries readiness after a native reveal error", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("reveal failed")).mockResolvedValue(undefined);

    renderApp();

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("window_ready");
    expect(mocks.invoke.mock.calls[1]?.[0]).toBe("window_ready");
  });

  it("adds a device through the narrow monitor command", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getAllByRole("button", { name: "Add Device" })[0]!);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Select Device" })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Available Keyboard" }));

    await waitFor(() => {
      expect(mocks.context.addDevice).toHaveBeenCalledWith({
        id: "kbd-2",
        name: "Available Keyboard",
      });
    });
  });

  it("routes device presentation changes to narrow monitor commands", async () => {
    const user = userEvent.setup();
    mocks.context.registeredDevices = [device("kbd-1", "Keyboard"), device("kbd-2", "Second")];
    renderApp();

    await user.click(screen.getAllByRole("button", { name: "Edit device display name" })[0]!);
    const nameField = screen.getByDisplayValue("Keyboard");
    await user.clear(nameField);
    await user.keyboard("Desk keyboard{Enter}");
    expect(mocks.context.setDeviceDisplayName).toHaveBeenCalledWith("kbd-1", "Desk keyboard");

    await user.click(screen.getAllByRole("button", { name: "Collapse device" })[0]!);
    expect(mocks.context.setDeviceCollapsed).toHaveBeenCalledWith("kbd-1", true);

    const secondRow = screen.getByText("Second").closest(".group");
    expect(secondRow).not.toBeNull();
    await user.hover(secondRow!);
    await user.click(within(secondRow as HTMLElement).getByRole("button", { name: "Open menu" }));
    await user.click(screen.getByRole("button", { name: "Move Up" }));
    expect(mocks.context.reorderDevices).toHaveBeenCalledWith(["kbd-2", "kbd-1"]);
  });

  it("routes remove and reload actions to monitor commands", async () => {
    const user = userEvent.setup();
    mocks.context.config = { ...defaultConfig, fetchInterval: 10_000 };
    mocks.context.registeredDevices = [device("kbd-1", "Keyboard")];
    renderApp();

    await user.hover(screen.getByText("Keyboard").closest(".group")!);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.context.removeDevice).toHaveBeenCalledWith("kbd-1");

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(mocks.context.reloadMonitor).toHaveBeenCalledOnce();
  });
});
