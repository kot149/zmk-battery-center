import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { MockSeed } from "../types";

export { expect };

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const mockScriptPaths = [
  path.join(e2eRoot, "support/tauri-mock/01-env-and-state.js"),
  path.join(e2eRoot, "support/tauri-mock/02-internals-and-invoke.js"),
] as const;

function cloneSeed(seed: MockSeed): MockSeed {
  return JSON.parse(JSON.stringify(seed)) as MockSeed;
}

export const baseSeed: MockSeed = {
  platform: "windows",
  availableDevices: [{ id: "kbd-1", name: "MockBoard One" }],
  batteryById: {
    "kbd-1": [{ battery_level: 87, user_description: "Central" }]
  }
};

export async function installTauriMock(page: Page, seed: MockSeed): Promise<void> {
  const payload = cloneSeed(seed);
  await page.addInitScript((nextSeed: MockSeed) => {
    window.__E2E_TAURI_SEED__ = nextSeed;
  }, payload);
  for (const scriptPath of mockScriptPaths) {
    await page.addInitScript({ path: scriptPath });
  }
}

export async function openApp(page: Page, seed: MockSeed): Promise<void> {
  await installTauriMock(page, seed);
  await page.goto("/");
}

export async function addFirstDevice(page: Page): Promise<void> {
  await page.getByLabel("Add Device").click();
  await expect(page.getByRole("heading", { name: "Select Device" })).toBeVisible();
  await page.getByRole("button", { name: "MockBoard One" }).click();
  await expect(page.getByText("MockBoard One")).toBeVisible();
}

export async function openDeviceMenu(page: Page, deviceName: string): Promise<void> {
  await page.locator("div.group").filter({ has: page.getByText(deviceName) }).hover();
  await page.getByRole("button", { name: "Open menu" }).click();
}

export function batteryLevelTestId(deviceId: string, userDescription: string): string {
  return `device-battery-level-${deviceId}-${userDescription}`;
}

export async function createSeededPage(context: BrowserContext, seed: MockSeed): Promise<Page> {
  const page = await context.newPage();
  await openApp(page, seed);
  return page;
}

export const test = base.extend<{ seed: MockSeed }>({
  seed: [baseSeed, { option: true }],
  page: async ({ page, seed }, use) => {
    await openApp(page, seed);
    await use(page);
  },
});
