import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExternalBatteryIntegration } from "@/hooks/use-external-battery-integration";
import type { RegisteredDevice } from "@/utils/app-helpers";

const mocks = vi.hoisted(() => ({
  buildExternalBatteryDevices: vi.fn((devices: RegisteredDevice[]) =>
    devices.map((device) => ({ id: device.id })),
  ),
  startExternalBatterySourceSession: vi.fn(async () => 7),
  publishExternalBatterySnapshot: vi.fn(async () => undefined),
}));

vi.mock("@/utils/external-battery-integration", () => ({
  buildExternalBatteryDevices: mocks.buildExternalBatteryDevices,
  startExternalBatterySourceSession: mocks.startExternalBatterySourceSession,
  publishExternalBatterySnapshot: mocks.publishExternalBatterySnapshot,
}));

vi.mock("@/utils/common", () => ({
  fireAndForget: vi.fn((promise: Promise<unknown>) => {
    void promise.catch(() => undefined);
  }),
}));

function device(): RegisteredDevice {
  return {
    id: "kbd-1",
    name: "Keyboard",
    batteryInfos: [],
    isDisconnected: false,
    isCollapsed: false,
  };
}

describe("useExternalBatteryIntegration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for device loading before publishing", async () => {
    const snapshot = { devices: [] as RegisteredDevice[], sourceRevision: 0 };
    const initialProps: {
      isDeviceLoaded: boolean;
      registeredDevices: RegisteredDevice[] | undefined;
    } = { isDeviceLoaded: false, registeredDevices: undefined };
    const view = renderHook(
      ({ isDeviceLoaded, registeredDevices }) =>
        useExternalBatteryIntegration({
          isDeviceLoaded,
          registeredDevices,
          getRegisteredDevicesSnapshot: () => snapshot,
        }),
      { initialProps },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mocks.publishExternalBatterySnapshot).not.toHaveBeenCalled();

    const devices = [device()];
    snapshot.devices = devices;
    snapshot.sourceRevision = 3;
    view.rerender({ isDeviceLoaded: true, registeredDevices: devices });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });

    expect(mocks.startExternalBatterySourceSession).toHaveBeenCalledOnce();
    expect(mocks.publishExternalBatterySnapshot).toHaveBeenCalledWith(7, 3, [{ id: "kbd-1" }]);
  });

  it("publishes the latest synchronous snapshot after device changes", async () => {
    const firstDevice = device();
    const snapshot = { devices: [firstDevice], sourceRevision: 1 };
    const view = renderHook(
      ({ registeredDevices }) =>
        useExternalBatteryIntegration({
          isDeviceLoaded: true,
          registeredDevices,
          getRegisteredDevicesSnapshot: () => snapshot,
        }),
      { initialProps: { registeredDevices: [firstDevice] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });

    const nextDevice = { ...firstDevice, id: "kbd-2" };
    snapshot.devices = [nextDevice];
    snapshot.sourceRevision = 2;
    view.rerender({ registeredDevices: [nextDevice] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });

    expect(mocks.publishExternalBatterySnapshot).toHaveBeenLastCalledWith(7, 2, [{ id: "kbd-2" }]);
  });

  it("starts a new source session after a frontend reload", async () => {
    mocks.startExternalBatterySourceSession.mockResolvedValueOnce(10).mockResolvedValueOnce(11);
    const firstDevice = device();
    const snapshot = { devices: [firstDevice], sourceRevision: 1 };
    const createView = () =>
      renderHook(
        ({ registeredDevices }) =>
          useExternalBatteryIntegration({
            isDeviceLoaded: true,
            registeredDevices,
            getRegisteredDevicesSnapshot: () => snapshot,
          }),
        { initialProps: { registeredDevices: [firstDevice] } },
      );

    const firstView = createView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });
    firstView.unmount();

    const secondView = createView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });
    secondView.unmount();

    expect(mocks.startExternalBatterySourceSession).toHaveBeenCalledTimes(2);
    expect(mocks.publishExternalBatterySnapshot).toHaveBeenNthCalledWith(1, 10, 1, [
      { id: "kbd-1" },
    ]);
    expect(mocks.publishExternalBatterySnapshot).toHaveBeenNthCalledWith(2, 11, 1, [
      { id: "kbd-1" },
    ]);
  });
});
