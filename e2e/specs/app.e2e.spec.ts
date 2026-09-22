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

test("add device flow uses the canonical monitor command", async ({ page }) => {
  await addFirstDevice(page);
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");

  const monitorAddCalls = await page.evaluate(() =>
    window.__e2eTauriMock.getInvocations().filter((entry) => entry.cmd === "monitor_add_device"),
  );
  expect(monitorAddCalls).toHaveLength(1);
  expect(monitorAddCalls[0]?.args?.device).toEqual({ id: "kbd-1", name: "MockBoard One" });
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

test("full monitor snapshots update battery information", async ({ page }) => {
  await addFirstDevice(page);
  await page.evaluate(() =>
    window.__e2eTauriMock.emitBatteryInfo("kbd-1", {
      battery_level: 42,
      user_description: "Central",
    }),
  );
  await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("42%");
});

test("full monitor snapshots update disconnected state", async ({ page }) => {
  await addFirstDevice(page);
  await page.evaluate(() => window.__e2eTauriMock.emitMonitorStatus("kbd-1", false));
  await expect(page.getByLabel("Disconnected")).toBeVisible();

  await page.evaluate(() => window.__e2eTauriMock.emitMonitorStatus("kbd-1", true));
  await expect(page.getByLabel("Disconnected")).toHaveCount(0);
});

test("remove device uses the canonical monitor command", async ({ page }) => {
  await addFirstDevice(page);
  await openDeviceMenu(page, "MockBoard One");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("heading", { name: "No devices registered" })).toBeVisible();

  const removeCalls = await page.evaluate(() =>
    window.__e2eTauriMock.getInvocations().filter((entry) => entry.cmd === "monitor_remove_device"),
  );
  expect(removeCalls).toHaveLength(1);
  expect(removeCalls[0]?.args?.id).toBe("kbd-1");
});

test("collapsed state is restored from the monitor snapshot", async ({ page, context }) => {
  await addFirstDevice(page);
  await page.getByRole("button", { name: "Collapse device" }).click();
  await expect(page.getByRole("button", { name: "Expand device" })).toBeVisible();

  const reloadedPage = await createSeededPage(context, {
    platform: "windows",
    availableDevices: [{ id: "kbd-1", name: "MockBoard One" }],
    batteryById: {
      "kbd-1": [{ battery_level: 87, user_description: "Central" }],
    },
  });
  await expect(reloadedPage.getByText("MockBoard One")).toBeVisible();
  await expect(reloadedPage.getByRole("button", { name: "Expand device" })).toBeVisible();
  await reloadedPage.close();
});

test.describe("numeric monitor reload", () => {
  test.use({
    seed: {
      ...baseSeed,
      config: { fetchInterval: 200 },
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

  test("refreshes battery info without frontend polling", async ({ page }) => {
    await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("87%");
    await page.evaluate(() => {
      window.__e2eTauriMock.setBatteryInfo("kbd-1", [
        { battery_level: 63, user_description: "Central" },
      ]);
    });
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId(batteryLevelTestId("kbd-1", "Central"))).toHaveText("63%");

    const reloadCalls = await page.evaluate(() =>
      window.__e2eTauriMock.getInvocations().filter((entry) => entry.cmd === "monitor_reload"),
    );
    expect(reloadCalls).toHaveLength(1);
  });
});

test("battery history chart accepts backend history events", async ({ page }) => {
  await addFirstDevice(page);
  await page
    .locator("div.group")
    .filter({ has: page.getByText("MockBoard One") })
    .hover();
  await page.getByRole("button", { name: "Show battery history chart" }).click();
  await expect(page.getByText("No history recorded yet")).toBeVisible();

  await page.evaluate(() => {
    return window.__e2eTauriMock.emit("battery-history-updated", {
      deviceId: "kbd-1",
      records: [
        {
          timestamp: new Date().toISOString(),
          user_description: "Central",
          battery_level: 48,
        },
      ],
    });
  });
  await expect(page.getByText("No history recorded yet")).toHaveCount(0);
});
