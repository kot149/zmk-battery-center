import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type MockBatteryInfo = {
  battery_level: number | null;
  user_description: string | null;
};

type MockDevice = {
  id: string;
  name: string;
};

type MockRegisteredDevice = {
  id: string;
  name: string;
  batteryInfos: MockBatteryInfo[];
  isDisconnected: boolean;
};

type MockSeed = {
  platform?: string;
  availableDevices?: MockDevice[];
  batteryById?: Record<string, MockBatteryInfo[]>;
  registeredDevices?: MockRegisteredDevice[];
};

type MockStoreData = {
  devices?: MockRegisteredDevice[];
};

declare global {
  interface Window {
    __E2E_TAURI_SEED__?: MockSeed;
    __e2eTauriMock: {
      emitBatteryInfo: (id: string, batteryInfo: MockBatteryInfo) => Promise<void>;
      readStore: (path: string) => MockStoreData;
    };
  }
}

const mockScriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../support/tauri-mock.js"
);

const baseSeed: MockSeed = {
  platform: "windows",
  availableDevices: [{ id: "kbd-1", name: "MockBoard One" }],
  batteryById: {
    "kbd-1": [{ battery_level: 87, user_description: "Central" }]
  }
};

async function openApp(page: Page, seed: MockSeed) {
  await page.addInitScript((nextSeed: MockSeed) => {
    window.__E2E_TAURI_SEED__ = nextSeed;
  }, seed);
  await page.addInitScript({ path: mockScriptPath });
  await page.goto("/");
}

async function addFirstDevice(page: Page) {
  await page.getByLabel("Add Device").click();
  await expect(page.getByRole("heading", { name: "Select Device" })).toBeVisible();
  await page.getByRole("button", { name: "MockBoard One" }).click();
  await expect(page.getByText("MockBoard One")).toBeVisible();
}

async function createSeededPage(context: BrowserContext, seed: MockSeed): Promise<Page> {
  const page = await context.newPage();
  await openApp(page, seed);
  return page;
}

test("first launch shows no registered devices", async ({ page }) => {
  await openApp(page, baseSeed);
  await expect(page.getByRole("heading", { name: "No devices registered" })).toBeVisible();
});

test("add device flow from modal list", async ({ page }) => {
  await openApp(page, baseSeed);
  await addFirstDevice(page);
  await expect(page.getByText("87%")).toBeVisible();
});

test("notification-monitor event updates device battery info", async ({ page }) => {
  await openApp(page, baseSeed);
  await addFirstDevice(page);
  await page.evaluate(() => {
    return window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
      battery_level: 42,
      user_description: "Central"
    });
  });
  await expect(page.getByText("42%")).toBeVisible();
});

test("persistence reload flow loads devices from mocked store on new page", async ({ page, context }) => {
  await openApp(page, baseSeed);
  await addFirstDevice(page);

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const data = window.__e2eTauriMock.readStore("devices.json");
        return data.devices?.length ?? 0;
      });
    })
    .toBe(1);

  const reloadedPage = await createSeededPage(context, {
    platform: "windows",
    availableDevices: [{ id: "kbd-1", name: "MockBoard One" }],
    batteryById: {
      "kbd-1": [{ battery_level: 87, user_description: "Central" }]
    }
  });

  await expect(reloadedPage.getByText("MockBoard One")).toBeVisible();
  await reloadedPage.close();
});
