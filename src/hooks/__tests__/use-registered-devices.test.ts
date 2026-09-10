import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRegisteredDevices } from "@/hooks/use-registered-devices";
import type { RegisteredDevice } from "@/utils/app-helpers";

const store = {
  get: vi.fn(),
  set: vi.fn(async () => undefined),
};

vi.mock("@/utils/storage", () => ({
  load: vi.fn(async () => store),
  getStorePath: vi.fn(async (filename: string) => filename),
}));

describe("useRegisteredDevices", () => {
  beforeEach(() => {
    store.get.mockReset();
    store.set.mockReset();
    store.set.mockResolvedValue(undefined);
    store.get.mockResolvedValue([]);
  });

  function loadedDevice(): RegisteredDevice {
    return {
      id: "kbd-1",
      name: "Keyboard",
      batteryInfos: [],
      isDisconnected: false,
      isCollapsed: false,
    };
  }

  it("does not commit before loading and exposes a synchronous ref snapshot", async () => {
    let resolveLoad!: (value: unknown) => void;
    store.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const view = renderHook(() => useRegisteredDevices());
    await waitFor(() => expect(store.get).toHaveBeenCalledWith("devices"));

    act(() => {
      view.result.current.commitRegisteredDevices(() => [loadedDevice()]);
    });
    expect(view.result.current.getRegisteredDevicesSnapshot()).toEqual({
      devices: [],
      sourceRevision: 0,
    });

    await act(async () => resolveLoad([]));
    await waitFor(() => expect(view.result.current.isDeviceLoaded).toBe(true));
    expect(view.result.current.getRegisteredDevicesSnapshot().sourceRevision).toBe(1);
  });

  it("applies synchronous commits sequentially and evaluates each recipe once", async () => {
    await act(async () => {
      await Promise.resolve();
    });
    const view = renderHook(() => useRegisteredDevices());
    await waitFor(() => expect(view.result.current.isDeviceLoaded).toBe(true));
    const firstRecipe = vi.fn((devices: RegisteredDevice[]) => [...devices, loadedDevice()]);
    const secondRecipe = vi.fn((devices: RegisteredDevice[]) => [
      ...devices,
      { ...loadedDevice(), id: "kbd-2" },
    ]);

    act(() => {
      view.result.current.commitRegisteredDevices(firstRecipe);
      view.result.current.commitRegisteredDevices(secondRecipe);
    });

    expect(firstRecipe).toHaveBeenCalledOnce();
    expect(secondRecipe).toHaveBeenCalledOnce();
    expect(view.result.current.getRegisteredDevicesSnapshot()).toMatchObject({
      devices: [expect.objectContaining({ id: "kbd-1" }), expect.objectContaining({ id: "kbd-2" })],
      sourceRevision: 3,
    });
  });
});
