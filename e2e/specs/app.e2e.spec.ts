import {
  addFirstDevice,
  batteryLevelTestId,
  baseSeed,
  createSeededPage,
  expect,
  openDeviceMenu,
  test,
} from "../fixtures/app";

test("first launch shows no registered devices", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "No devices registered" })).toBeVisible();
});

test("add device flow from modal list", async ({ page }) => {
  await addFirstDevice(page);
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
});

test.describe("add device modal with no devices", () => {
  test.use({
    seed: {
      platform: "windows",
      availableDevices: [],
      batteryById: {},
    },
  });

  test("shows empty state when no devices are available", async ({ page }) => {
    await page.getByLabel("Add Device").click();
    await expect(page.getByRole("heading", { name: "Select Device" })).toBeVisible();
    await expect(page.getByText("No devices found")).toBeVisible();
  });
});

test("notification-monitor event updates device battery info", async ({ page }) => {
  await addFirstDevice(page);
  await page.evaluate(() => {
    return window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
      battery_level: 42,
      user_description: "Central",
    });
  });
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("42%");
});

test("notification-monitor event retains previous battery level when payload is null", async ({
  page,
}) => {
  await addFirstDevice(page);
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
  await page.evaluate(() => {
    return window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
      battery_level: null,
      user_description: "Central",
    });
  });
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
});

test("remove device returns to empty registered state", async ({ page }) => {
  await addFirstDevice(page);
  await openDeviceMenu(page, "MockBoard One");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("heading", { name: "No devices registered" })).toBeVisible();
});

test("remove device updates persistence payload", async ({ page }) => {
  await addFirstDevice(page);

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        return window.__e2eTauriMock.readStore("devices.json").devices?.length ?? 0;
      });
    })
    .toBe(1);

  await openDeviceMenu(page, "MockBoard One");
  await page.getByRole("button", { name: "Remove" }).click();

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        return window.__e2eTauriMock.readStore("devices.json").devices?.length ?? 0;
      });
    })
    .toBe(0);
});

test("persistence reload flow loads devices from mocked store on new page", async ({
  page,
  context,
}) => {
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
      "kbd-1": [{ battery_level: 87, user_description: "Central" }],
    },
  });

  await expect(reloadedPage.getByText("MockBoard One")).toBeVisible();
  await expect(reloadedPage.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
  await reloadedPage.close();
});

test.describe("legacy saved device payload", () => {
  test.use({
    seed: {
      platform: "windows",
      availableDevices: [],
      batteryById: {},
      registeredDevices: [
        {
          id: 'DeviceId("legacy-id")',
          name: 'DeviceId("Legacy Keyboard")',
          isDisconnected: true,
          batteryInfos: [{ battery_level: 73, user_description: "Left" }],
        },
      ],
    },
  });

  test("is normalized on load", async ({ page }) => {
    await expect(page.getByText("Legacy Keyboard")).toBeVisible();
    await expect(page.getByTestId(batteryLevelTestId("legacy-id", "Left"))).toHaveText("73%");
    await expect(page.getByText("disconnected")).toBeVisible();
  });
});

test("notification monitor status event updates disconnected badge", async ({ page }) => {
  await addFirstDevice(page);

  await page.evaluate(() => window.__e2eTauriMock.emitMonitorStatus("kbd-1", false));
  await expect(page.getByText("disconnected")).toBeVisible();

  await page.evaluate(() => window.__e2eTauriMock.emitMonitorStatus("kbd-1", true));
  await expect(page.getByText("disconnected")).toHaveCount(0);
});

test("adding same device twice does not duplicate registered entry", async ({ page }) => {
  await addFirstDevice(page);
  await page.getByLabel("Add Device").click();
  await expect(page.getByText("No devices found")).toBeVisible();

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        return window.__e2eTauriMock.readStore("devices.json").devices?.length ?? 0;
      });
    })
    .toBe(1);
});

test.describe("monitor startup with empty initial battery info", () => {
  test.use({
    seed: {
      platform: "windows",
      availableDevices: [{ id: "kbd-1", name: "MockBoard One" }],
      batteryById: { "kbd-1": [] },
    },
  });

  test("marks device disconnected until first event", async ({ page }) => {
    await addFirstDevice(page);
    await expect(page.getByText("disconnected")).toBeVisible();

    await page.evaluate(() => {
      return window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
        battery_level: 51,
        user_description: "Central",
      });
    });
    await expect(page.getByText("disconnected")).toHaveCount(0);
    await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("51%");
  });
});

test.describe("polling mode refresh", () => {
  test.use({
    seed: {
      ...baseSeed,
      config: {
        fetchInterval: 200,
      },
      registeredDevices: [
        {
          id: "kbd-1",
          name: "MockBoard One",
          isDisconnected: false,
          batteryInfos: [{ battery_level: 87, user_description: "Central" }],
        },
      ],
    },
  });

  test("updates battery level on interval", async ({ page }) => {
    await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
    await page.evaluate(() => {
      window.__e2eTauriMock.setBatteryInfo("kbd-1", [{ battery_level: 63, user_description: "Central" }]);
    });
    await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("63%");
  });
});

test("battery history event refreshes chart after new reading", async ({ page }) => {
  await addFirstDevice(page);

  await page.locator("div.group").filter({ has: page.getByText("MockBoard One") }).hover();
  await page.getByRole("button", { name: "Show battery history chart" }).click();
  await expect(page.getByText("No history recorded yet")).toBeVisible();

  await page.evaluate(() => {
    return window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
      battery_level: 48,
      user_description: "Central",
    });
  });

  await expect(page.getByText("No history recorded yet")).toHaveCount(0);
});
