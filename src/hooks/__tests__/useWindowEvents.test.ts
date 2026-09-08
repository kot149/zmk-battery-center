import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowEvents } from "../useWindowEvents";
import { defaultConfig, type Config } from "@/utils/config";
import { hideWindow, setWindowAlwaysOnTop } from "@/utils/window";

const { mockOnFocusChanged, mockOnMoved, mockIsVisible, mockIsFocused } = vi.hoisted(() => ({
  mockOnFocusChanged: vi.fn(),
  mockOnMoved: vi.fn(),
  mockIsVisible: vi.fn(async () => true),
  mockIsFocused: vi.fn(async () => true),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onFocusChanged: mockOnFocusChanged,
    onMoved: mockOnMoved,
    isVisible: mockIsVisible,
    isFocused: mockIsFocused,
  }),
}));

vi.mock("@/utils/window", () => ({
  hideWindow: vi.fn(),
  moveWindowTo: vi.fn(async () => undefined),
  getIsWindowMovingByPlugin: vi.fn(() => false),
  setWindowAlwaysOnTop: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn(async () => null) }));

function blur() {
  const handler = mockOnFocusChanged.mock.calls[0]?.[0];
  if (!handler) throw new Error("onFocusChanged was never registered");
  handler({ payload: false });
}

function render(config: Config, isConfigLoaded = true) {
  return renderHook(() =>
    useWindowEvents({ config, isConfigLoaded, onWindowPositionChange: vi.fn() }),
  );
}

describe("useWindowEvents pin behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockOnFocusChanged.mockResolvedValue(() => undefined);
    mockOnMoved.mockResolvedValue(() => undefined);
  });

  it("hides on blur when the window is not pinned", async () => {
    render({ ...defaultConfig, pinWindow: false });
    await vi.waitFor(() => expect(mockOnFocusChanged).toHaveBeenCalled());

    blur();
    vi.advanceTimersByTime(300);

    expect(hideWindow).toHaveBeenCalled();
  });

  it("stays open on blur when the window is pinned", async () => {
    render({ ...defaultConfig, pinWindow: true });
    await vi.waitFor(() => expect(mockOnFocusChanged).toHaveBeenCalled());

    blur();
    vi.advanceTimersByTime(300);

    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("does not hide before the stored config has loaded", async () => {
    render({ ...defaultConfig, pinWindow: false }, false);
    await vi.waitFor(() => expect(mockOnFocusChanged).toHaveBeenCalled());

    blur();
    vi.advanceTimersByTime(300);

    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("applies always-on-top to match the pin setting", async () => {
    render({ ...defaultConfig, pinWindow: true });
    expect(setWindowAlwaysOnTop).toHaveBeenCalledWith(true);

    vi.clearAllMocks();
    render({ ...defaultConfig, pinWindow: false });
    expect(setWindowAlwaysOnTop).toHaveBeenCalledWith(false);
  });
});
