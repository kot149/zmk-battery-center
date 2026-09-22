import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const root = process.cwd();

async function waitFor<T>(read: () => Promise<T>, valid: (value: T) => boolean, timeout = 30_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = await read();
    if (valid(value)) return value;
    await delay(100);
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function invoke<T>(
  page: Page,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    ({ command, args }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (command: string, args: Record<string, unknown>) => Promise<T>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
}

type Snapshot = {
  revision: number;
  config: { pinWindow: boolean };
  devices: Array<{ id: string; displayName?: string }>;
};
type Metrics = {
  processes: number;
  webviews: number;
  workingSetBytes: number;
  privateBytes: number;
};

async function main() {
  assert.equal(process.platform, "win32", "This lifecycle test uses the Windows tray");
  const binary = resolve(root, "target/debug/zmk-battery-center.exe");
  await mkdir(resolve(root, "test-results"), { recursive: true });
  const dataDir = await mkdtemp(resolve(root, "test-results/window-lifecycle-"));
  await writeFile(
    resolve(dataDir, "config.json"),
    JSON.stringify({ config: { pinWindow: true, fetchInterval: 1000 } }),
  );
  await writeFile(
    resolve(dataDir, "devices.json"),
    JSON.stringify({
      devices: [
        {
          id: "lifecycle-test-device",
          name: "Lifecycle fixture",
          batteryInfos: [],
          isDisconnected: true,
          isCollapsed: false,
        },
      ],
    }),
  );
  const port = await unusedPort();
  const app = spawn(binary, [], {
    env: {
      ...process.env,
      CARGO_MANIFEST_DIR: resolve(root, "src-tauri"),
      ZMK_BATTERY_CENTER_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  app.stdout.on("data", (chunk) => {
    output += chunk;
  });
  app.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<void>((done) => app.once("exit", () => done()));
  await new Promise<void>((done, reject) => {
    app.once("spawn", done);
    app.once("error", reject);
  });
  const driver = async (action: "click" | "quick-reopen" | "close" | "metrics") => {
    assert.equal(app.exitCode, null, `App exited early: ${output}`);
    const { stdout } = await exec("powershell", [
      "-NoProfile",
      "-File",
      resolve(root, "scripts/window_test_driver.ps1"),
      "-ProcessId",
      String(app.pid),
      "-Action",
      action,
    ]);
    return stdout.trim();
  };
  const metrics = async () => JSON.parse(await driver("metrics")) as Metrics;
  let browser: Browser | undefined;
  const samples: Record<string, Metrics | number | string> = {};
  const waitForSuspension = (offset: number) =>
    waitFor(async () => {
      assert.equal(app.exitCode, null, `App exited early: ${output}`);
      return (
        output
          .slice(offset)
          .match(
            /Suspended hidden main WebView|Main WebView declined suspension|Failed to suspend main WebView|Failed to schedule main WebView suspension/,
          )?.[0] ?? ""
      );
    }, Boolean);
  try {
    await delay(2500);
    samples.startup = await metrics();
    assert.equal(
      samples.startup.webviews,
      0,
      "Headless startup must not create WebView2 processes",
    );

    const firstClickAt = Number(await driver("click"));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        return false;
      }
    }, Boolean);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(
      async () =>
        browser!
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => !candidate.url().startsWith("devtools:")),
      (candidate) => !!candidate,
    );
    assert(page);
    await page.waitForSelector("#app");
    await waitFor(
      () => invoke<boolean>(page, "plugin:window|is_visible", { label: "main" }),
      Boolean,
    );
    assert((await page.locator("#app").innerText()).length > 0, "Window must render content");
    const first = { page, duration: Date.now() - firstClickAt };
    samples.firstOpenMs = first.duration;
    assert.equal(
      await invoke<string>(first.page, "plugin:app|identifier"),
      "com.zmk-battery-center.lifecycle-test",
      "Build with the isolated lifecycle-test identifier before running this test",
    );
    await first.page.evaluate(() => {
      document.documentElement.dataset.lifecycleMarker = "original-view";
    });
    await driver("quick-reopen");
    await delay(1500);
    assert.equal(
      await first.page.evaluate(() => document.documentElement.dataset.lifecycleMarker),
      "original-view",
      "Reopening within the grace period must reuse the original WebView",
    );
    assert(await invoke<boolean>(first.page, "plugin:window|is_visible", { label: "main" }));
    samples.visible = await metrics();
    assert(samples.visible.webviews > 0);
    await first.page.screenshot({ path: resolve(dataDir, "visible.png") });
    const snapshot = await invoke<Snapshot>(first.page, "get_monitor_state");
    assert.equal(snapshot.devices[0]?.id, "lifecycle-test-device");
    const beforeHide = await invoke<Snapshot>(first.page, "monitor_set_device_display_name", {
      id: "lifecycle-test-device",
      displayName: "Retained WebView",
    });
    const hideLogOffset = output.length;
    await driver("click");
    await waitFor(
      () => invoke<boolean>(first.page, "plugin:window|is_visible", { label: "main" }),
      (visible) => !visible,
    );
    // Mutate before the suspension grace period ends, then leave the renderer idle.
    await invoke<Snapshot>(first.page, "monitor_set_device_display_name", {
      id: "lifecycle-test-device",
      displayName: "Changed while hidden",
    });
    samples.suspension = await waitForSuspension(hideLogOffset);
    samples.hidden = await metrics();
    const stored = JSON.parse(await readFile(resolve(dataDir, "devices.json"), "utf8"));
    assert.equal(stored.devices[0].displayName, "Changed while hidden");
    const readPublished = async () =>
      JSON.parse(await readFile(resolve(dataDir, "external/battery-state-v1.json"), "utf8")) as {
        revision: number;
        generatedAtUnixMs: number;
      };
    const published = await readPublished();
    const hiddenAt = Date.now();
    await waitFor(
      readPublished,
      (next) => next.revision > published.revision && next.generatedAtUnixMs > hiddenAt,
    );
    const reopenAt = Number(await driver("click"));
    await waitFor(
      () => invoke<boolean>(page, "plugin:window|is_visible", { label: "main" }),
      Boolean,
    );
    await page.getByText("Changed while hidden").waitFor();
    samples.reopenMs = Date.now() - reopenAt;
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.lifecycleMarker),
      "original-view",
      "Reopening after suspension must retain the original WebView",
    );
    assert.equal(
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .filter((candidate) => !candidate.url().startsWith("devtools:")).length,
      1,
      "Reopening must not create a second main page",
    );
    const restored = await invoke<Snapshot>(page, "get_monitor_state");
    assert(
      restored.revision > beforeHide.revision,
      "Background state must advance while the view is hidden",
    );
    assert.equal(restored.devices[0]?.displayName, "Changed while hidden");
    await page.screenshot({ path: resolve(dataDir, "reopened.png") });
    const closeLogOffset = output.length;
    await driver("close");
    await waitFor(
      () => invoke<boolean>(page, "plugin:window|is_visible", { label: "main" }),
      (visible) => !visible,
    );
    samples.closeSuspension = await waitForSuspension(closeLogOffset);
    samples.hiddenAgain = await metrics();
    console.log(JSON.stringify({ dataDir, samples }, null, 2));
    console.log("Windows retained WebView lifecycle test passed.");
  } finally {
    await browser?.close().catch(() => {});
    if (app.exitCode === null) app.kill();
    await Promise.race([exited, delay(5000)]);
    await writeFile(resolve(dataDir, "metrics.json"), JSON.stringify(samples, null, 2));
    await writeFile(resolve(dataDir, "app.log"), output);
    console.log(`Lifecycle artifacts: ${dataDir}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
