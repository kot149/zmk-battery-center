import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as transport from "@tauri-apps/plugin-log";
import { formatLogArgs, initializeLogging, logger, setFrontendLogLevel } from "../log";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  setFrontendLogLevel("debug");
  vi.clearAllMocks();
});

describe("logging", () => {
  it("preserves objects, error stacks and causes without failing on cycles or getters", () => {
    const cause = new Error("root cause");
    const error = new Error("failed");
    Object.assign(error, { cause });
    const cyclic: Record<string, unknown> = { count: 42, big: BigInt(9), error };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    const output = formatLogArgs([cyclic]);
    for (const expected of [
      "count: 42",
      "9",
      "root cause",
      "failed",
      "[circular]",
      "[unreadable]",
      error.stack!,
    ]) {
      expect(output).toContain(expected);
    }
  });

  it("bounds UTF-8 output and nesting", () => {
    const output = formatLogArgs(["日".repeat(100_000)]);
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(16 * 1024);
    expect(output).toContain("[truncated]");
    expect(output).not.toContain("�");
    let deep: unknown = "end";
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(formatLogArgs([deep])).toContain("[depth limit]");
  });

  it("does not evaluate disabled arguments or send IPC", async () => {
    const lazy = vi.fn(() => "expensive");
    setFrontendLogLevel("warn");
    await logger.info(lazy);
    await logger.debug(lazy);
    await logger.trace(lazy);
    expect(lazy).not.toHaveBeenCalled();
    expect(transport.info).not.toHaveBeenCalled();
    expect(transport.debug).not.toHaveBeenCalled();
    setFrontendLogLevel("info");
    await logger.info(lazy);
    expect(lazy).toHaveBeenCalledOnce();
    expect(transport.info).toHaveBeenCalledWith("expensive");
  });

  it("catches transport failures without recursive logging or unhandled rejection", async () => {
    vi.mocked(transport.warn).mockRejectedValueOnce(new Error("IPC failed"));
    await expect(logger.warn("warning")).resolves.toBeUndefined();
    expect(transport.warn).toHaveBeenCalledOnce();
    expect(transport.error).not.toHaveBeenCalled();
  });

  it("initializes once and restores console and global handlers", async () => {
    setFrontendLogLevel("info");
    dispose = initializeLogging();
    expect(initializeLogging()).toBe(dispose);
    console.log("object", { count: 1 });
    expect(transport.info).toHaveBeenCalledOnce();
    expect(vi.mocked(transport.info).mock.calls[0][0]).toContain("count: 1");
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason: new Error("unhandled") });
    window.dispatchEvent(event);
    expect(transport.error).toHaveBeenCalledOnce();
    dispose();
    dispose = undefined;
    window.dispatchEvent(event);
    expect(transport.error).toHaveBeenCalledOnce();
  });
});
