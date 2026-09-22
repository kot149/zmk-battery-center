import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigProvider, useConfigContext } from "../config-provider";
import { ThemeProvider } from "../theme-provider";
import { defaultConfig } from "../../utils/config";
import type { RegisteredDevice } from "../../utils/app-helpers";
import * as monitorModule from "../../utils/monitor";

const mockListen = vi.fn();
const mockUnlisten = vi.fn();
let monitorStateHandler: ((event: { payload: monitorModule.MonitorSnapshot }) => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("../../utils/monitor", () => ({
  getMonitorState: vi.fn(),
  updateMonitorConfig: vi.fn(),
  addMonitorDevice: vi.fn(),
  removeMonitorDevice: vi.fn(),
  setMonitorDeviceDisplayName: vi.fn(),
  setMonitorPartLabel: vi.fn(),
  setMonitorDeviceCollapsed: vi.fn(),
  reorderMonitorDevices: vi.fn(),
  reloadMonitor: vi.fn(),
}));

vi.mock("@/utils/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const device: RegisteredDevice = {
  id: "kbd-1",
  name: "Keyboard",
  batteryInfos: [],
  isDisconnected: false,
  isCollapsed: false,
};

function snapshot(revision = 1, overrides: Partial<monitorModule.MonitorSnapshot> = {}) {
  return {
    revision,
    config: { ...defaultConfig },
    devices: [device],
    ...overrides,
  } satisfies monitorModule.MonitorSnapshot;
}

function ConfigDisplay() {
  const { config, isConfigLoaded, isMonitorHydrationSettled, monitorError, registeredDevices } =
    useConfigContext();
  return (
    <div>
      <span data-testid="loaded">{isConfigLoaded ? "yes" : "no"}</span>
      <span data-testid="hydration-settled">{isMonitorHydrationSettled ? "yes" : "no"}</span>
      <span data-testid="monitor-error">{monitorError ?? ""}</span>
      <span data-testid="theme">{config.theme}</span>
      <span data-testid="fetchInterval">{String(config.fetchInterval)}</span>
      <span data-testid="device-count">{registeredDevices?.length ?? 0}</span>
    </div>
  );
}

function UpdateButton() {
  const { setConfig } = useConfigContext();
  return (
    <button type="button" onClick={() => setConfig((prev) => ({ ...prev, autoStart: true }))}>
      Update
    </button>
  );
}

function DeviceButton() {
  const { removeDevice } = useConfigContext();
  return <button onClick={() => void removeDevice("kbd-1")}>Remove</button>;
}

function renderWithProviders(children: ReactNode) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <ConfigProvider>{children}</ConfigProvider>
    </ThemeProvider>,
  );
}

describe("ConfigContext", () => {
  beforeEach(() => {
    vi.mocked(monitorModule.getMonitorState).mockReset();
    vi.mocked(monitorModule.updateMonitorConfig).mockReset();
    vi.mocked(monitorModule.removeMonitorDevice).mockReset();
    vi.mocked(monitorModule.getMonitorState).mockResolvedValue(snapshot());
    vi.mocked(monitorModule.updateMonitorConfig).mockResolvedValue(snapshot(2));
    vi.mocked(monitorModule.removeMonitorDevice).mockResolvedValue(snapshot(2, { devices: [] }));
    mockListen.mockReset();
    mockUnlisten.mockReset();
    monitorStateHandler = undefined;
    mockListen.mockImplementation(
      async (
        event: string,
        handler: (event: { payload: monitorModule.MonitorSnapshot }) => void,
      ) => {
        if (event === "monitor-state-changed") {
          monitorStateHandler = handler;
        }
        return mockUnlisten;
      },
    );
  });

  it("hydrates config and devices from the canonical monitor snapshot", async () => {
    vi.mocked(monitorModule.getMonitorState).mockResolvedValue(
      snapshot(4, {
        config: { ...defaultConfig, theme: "light", fetchInterval: "auto" },
        devices: [device],
      }),
    );

    renderWithProviders(<ConfigDisplay />);

    await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("yes"));
    expect(screen.getByTestId("hydration-settled").textContent).toBe("yes");
    expect(screen.getByTestId("monitor-error").textContent).toBe("");
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(screen.getByTestId("fetchInterval").textContent).toBe("auto");
    expect(screen.getByTestId("device-count").textContent).toBe("1");
    expect(monitorModule.getMonitorState).toHaveBeenCalledOnce();
  });

  it("settles hydration and exposes the load error when the snapshot cannot be loaded", async () => {
    vi.mocked(monitorModule.getMonitorState).mockRejectedValueOnce(
      new Error("backend unavailable"),
    );

    renderWithProviders(<ConfigDisplay />);

    await waitFor(() => expect(screen.getByTestId("hydration-settled").textContent).toBe("yes"));
    expect(screen.getByTestId("loaded").textContent).toBe("no");
    expect(screen.getByTestId("monitor-error").textContent).toBe(
      "Failed to load monitor state: backend unavailable",
    );
  });

  it("keeps a subscription error visible after snapshot hydration succeeds", async () => {
    mockListen.mockRejectedValueOnce(new Error("event bridge unavailable"));

    renderWithProviders(<ConfigDisplay />);

    await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("yes"));
    expect(screen.getByTestId("hydration-settled").textContent).toBe("yes");
    expect(screen.getByTestId("monitor-error").textContent).toBe(
      "Failed to subscribe to monitor state: event bridge unavailable",
    );
  });

  it("ignores snapshots older than the current revision", async () => {
    renderWithProviders(<ConfigDisplay />);
    await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("yes"));

    await act(async () => {
      monitorStateHandler?.({
        payload: snapshot(0, { config: { ...defaultConfig, theme: "light" }, devices: [] }),
      });
    });

    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(screen.getByTestId("device-count").textContent).toBe("1");
  });

  it("sends only changed config fields through the monitor patch command", async () => {
    renderWithProviders(<UpdateButton />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeTruthy());

    await act(async () => {
      screen.getByRole("button", { name: "Update" }).click();
    });

    await waitFor(() => {
      expect(monitorModule.updateMonitorConfig).toHaveBeenCalledWith({ autoStart: true });
    });
  });

  it("applies device command responses as canonical snapshots", async () => {
    renderWithProviders(
      <>
        <ConfigDisplay />
        <DeviceButton />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("yes"));

    await act(async () => {
      screen.getByRole("button", { name: "Remove" }).click();
    });

    await waitFor(() => expect(monitorModule.removeMonitorDevice).toHaveBeenCalledWith("kbd-1"));
    await waitFor(() => expect(screen.getByTestId("device-count").textContent).toBe("0"));
  });

  it("unlistens from monitor snapshots on unmount", async () => {
    const view = renderWithProviders(<ConfigDisplay />);
    await waitFor(() =>
      expect(mockListen).toHaveBeenCalledWith("monitor-state-changed", expect.any(Function)),
    );

    view.unmount();
    await waitFor(() => expect(mockUnlisten).toHaveBeenCalledTimes(1));
  });

  it("throws when used outside ConfigProvider", () => {
    expect(() => render(<ConfigDisplay />)).toThrow(
      "useConfigContext must be used within a ConfigProvider",
    );
  });
});
