import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { TrayIcon, TrayIconEvent } from "@tauri-apps/api/tray";
import { Menu, Submenu, CheckMenuItem } from "@tauri-apps/api/menu";
import {
  isWindowVisible,
  showWindow,
  hideWindow,
  moveWindowToTrayCenter,
  setWindowFocus,
  setTrayPositionSet,
  moveWindowTo,
} from "@/utils/window";
import { exitApp } from "@/utils/common";
import { stopAllBatteryMonitors } from "@/utils/ble";
import { logger } from "@/utils/log";
import { Config } from "@/utils/config";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { platform } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";

interface UseTrayEventsOptions {
  config: Config;
  isConfigLoaded: boolean;
  onManualWindowPositioningChange: (enabled: boolean) => void;
  onPinWindowChange: (enabled: boolean) => void;
}

export function useTrayEvents({
  config,
  isConfigLoaded,
  onManualWindowPositioningChange,
  onPinWindowChange,
}: UseTrayEventsOptions) {
  const configRef = useRef(config);
  const onManualWindowPositioningChangeRef = useRef(onManualWindowPositioningChange);
  const onPinWindowChangeRef = useRef(onPinWindowChange);
  const menuRef = useRef<Menu | null>(null);

  useEffect(() => {
    configRef.current = config;
    onManualWindowPositioningChangeRef.current = onManualWindowPositioningChange;
    onPinWindowChangeRef.current = onPinWindowChange;
  });

  // Synchronize backend state whenever manualWindowPositioning config changes
  useEffect(() => {
    if (!isConfigLoaded) return;
    if (platform() === "linux") {
      invoke("update_manual_positioning", { enabled: config.manualWindowPositioning }).catch(
        (err) => logger.error(`Failed to update manual positioning in backend: ${err}`),
      );
    }
  }, [config.manualWindowPositioning, isConfigLoaded]);

  // Synchronize backend state whenever pinWindow config changes (Linux)
  useEffect(() => {
    if (!isConfigLoaded) return;
    if (platform() === "linux") {
      invoke("update_pin_window", { enabled: config.pinWindow }).catch((err) =>
        logger.error(`Failed to update pin window in backend: ${err}`),
      );
    }
  }, [config.pinWindow, isConfigLoaded]);

  // Keep the tray check items in sync when config changes elsewhere
  // (e.g. the main view pin button).
  useEffect(() => {
    if (!isConfigLoaded) return;
    const menu = menuRef.current;
    if (!menu) return;
    const syncCheckedState = async () => {
      try {
        const controlMenu = (await menu.get("control")) as Submenu | null;
        if (!controlMenu) return;
        const manualItem = (await controlMenu.get(
          "manual_window_positioning",
        )) as CheckMenuItem | null;
        if (manualItem) {
          const isChecked = await manualItem.isChecked();
          if (isChecked !== configRef.current.manualWindowPositioning) {
            await manualItem.setChecked(configRef.current.manualWindowPositioning);
          }
        }
        const pinItem = (await controlMenu.get("pin_window")) as CheckMenuItem | null;
        if (pinItem) {
          const isChecked = await pinItem.isChecked();
          if (isChecked !== configRef.current.pinWindow) {
            await pinItem.setChecked(configRef.current.pinWindow);
          }
        }
      } catch (err) {
        logger.error(`Failed to sync tray menu checked state: ${err}`);
      }
    };
    void syncCheckedState();
  }, [config.manualWindowPositioning, config.pinWindow, isConfigLoaded]);

  useEffect(() => {
    if (!isConfigLoaded) return;

    let cancelled = false;
    const unlistens: Array<() => void> = [];
    // Listeners registered after cleanup (StrictMode first mount, fast
    // unmount) are unlistened immediately instead of leaking.
    const track = (unlisten: () => void) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistens.push(unlisten);
      }
    };

    const showWindowAtConfiguredPosition = async (manualOverride?: boolean) => {
      const manual = manualOverride ?? configRef.current.manualWindowPositioning;
      await showWindow();
      if (!manual) {
        await moveWindowToTrayCenter();
      } else {
        await moveWindowTo(configRef.current.windowPosition.x, configRef.current.windowPosition.y);
      }
      await setWindowFocus();
    };

    const openAboutWindow = async () => {
      let aboutWindow = await WebviewWindow.getByLabel("about");
      if (!aboutWindow) {
        aboutWindow = new WebviewWindow("about", {
          url: "about.html",
          title: "zmk-battery-center - About",
          width: 600,
          height: 500,
          center: true,
          resizable: true,
          decorations: true,
        });
      }
      await aboutWindow.show();
      await aboutWindow.setFocus();
    };

    const setupTray = async () => {
      const isLinux = platform() === "linux";
      const tray = isLinux ? null : await TrayIcon.getById("tray_icon");
      if (cancelled) return;
      if (!isLinux && !tray) {
        logger.error("Tray icon not found");
        return;
      }

      // Set tray position flag on first tray event
      let isTrayPositionSet = false;
      if (tray) {
        track(
          await listen<TrayIconEvent>("tray_event", () => {
            if (!isTrayPositionSet) {
              isTrayPositionSet = true;
              setTrayPositionSet(true);
              logger.info("Tray position set");
            }
          }),
        );
      }

      // Handle tray left click
      track(
        await listen("tray_left_click", async () => {
          const isVisible = await isWindowVisible();
          if (isVisible) {
            hideWindow();
          } else {
            await showWindowAtConfiguredPosition();
          }
        }),
      );

      // Create tray menu
      const menu = await Menu.new({
        items: [
          {
            id: "show",
            text: "Show",
            action: async () => {
              await showWindowAtConfiguredPosition();
            },
          },
          {
            id: "control",
            text: "Control",
            items: [
              {
                id: "refresh",
                text: "Refresh window",
                action: async () => {
                  await stopAllBatteryMonitors();
                  location.reload();
                  await showWindowAtConfiguredPosition();
                },
              },
              {
                id: "manual_window_positioning",
                text: "Manual window positioning",
                checked: configRef.current.manualWindowPositioning,
                action: async (trayId: string) => {
                  const controlMenu = (await menu?.get("control")) as Submenu | null;
                  const thisMenu = (await controlMenu?.get(trayId)) as CheckMenuItem | null;
                  if (!thisMenu) return;

                  const isChecked = await thisMenu.isChecked();
                  await showWindowAtConfiguredPosition(isChecked);

                  onManualWindowPositioningChangeRef.current(isChecked);
                },
              },
              {
                id: "pin_window",
                text: "Pin window",
                checked: configRef.current.pinWindow,
                action: async (trayId: string) => {
                  const controlMenu = (await menu?.get("control")) as Submenu | null;
                  const thisMenu = (await controlMenu?.get(trayId)) as CheckMenuItem | null;
                  if (!thisMenu) return;

                  const isChecked = await thisMenu.isChecked();
                  onPinWindowChangeRef.current(isChecked);
                },
              },
            ],
          },
          {
            id: "about",
            text: "About",
            action: openAboutWindow,
          },
          {
            id: "quit",
            text: "Quit",
            action: () => {
              exitApp();
            },
          },
        ],
      });

      if (platform() !== "linux") {
        if (tray) {
          await tray.setMenu(menu);
          await tray.setShowMenuOnLeftClick(false);
        }
        menuRef.current = menu;
      } else {
        if (cancelled) return;
        // Initialize Rust state
        await invoke("update_manual_positioning", {
          enabled: configRef.current.manualWindowPositioning,
        });
        await invoke("update_pin_window", {
          enabled: configRef.current.pinWindow,
        });

        track(
          await listen("tray_menu_refresh", async () => {
            await stopAllBatteryMonitors();
            location.reload();
            await showWindowAtConfiguredPosition();
          }),
        );

        track(
          await listen("tray_menu_toggle_manual_positioning", async () => {
            const isChecked = !configRef.current.manualWindowPositioning;
            await showWindowAtConfiguredPosition(isChecked);
            onManualWindowPositioningChangeRef.current(isChecked);
            await invoke("update_manual_positioning", { enabled: isChecked });
          }),
        );

        track(
          await listen("tray_menu_toggle_pin_window", async () => {
            const isChecked = !configRef.current.pinWindow;
            onPinWindowChangeRef.current(isChecked);
            await invoke("update_pin_window", { enabled: isChecked });
          }),
        );

        track(await listen("tray_menu_about", openAboutWindow));
      }
    };

    setupTray();

    return () => {
      cancelled = true;
      menuRef.current = null;
      for (const unlisten of unlistens.splice(0)) unlisten();
    };
  }, [isConfigLoaded]);
}
