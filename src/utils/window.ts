import { LogicalPosition, LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { Position, moveWindow } from "@tauri-apps/plugin-positioner";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "./log";
import { platform } from "@tauri-apps/plugin-os";

const appWindow = getCurrentWebviewWindow();
const currentPlatform = platform();

// These will be managed by useWindowEvents hook
let isTrayPositionSet = false;
let isWindowMovingByPlugin = false;

export function setTrayPositionSet(value: boolean) {
  isTrayPositionSet = value;
}

export function setIsWindowMovingByPlugin(value: boolean) {
  isWindowMovingByPlugin = value;
}

export function getIsWindowMovingByPlugin(): boolean {
  return isWindowMovingByPlugin;
}

async function waitForWindowMoveEnd() {
  while (isWindowMovingByPlugin) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function resizeWindow(x: number, y: number) {
  logger.info(`resizeWindow: ${x}x${y}`);
  const scaleFactor = await invoke<number>("get_windows_text_scale_factor");
  const width = x * scaleFactor;
  const height = y * scaleFactor;

  logger.info(`scaled size: ${width}x${height}`);

  await appWindow.setSize(new LogicalSize(width, height));
}

export async function resizeWindowToContent() {
  const appEl = document.getElementById("app");
  const width = appEl?.clientWidth ?? 0;
  const height = appEl?.clientHeight ?? 0;
  await resizeWindow(width, height);
}

export function isWindowVisible() {
  return appWindow.isVisible();
}

export function showWindow() {
  return appWindow.show();
}

export function hideWindow() {
  return invoke("dismiss_main_window").catch((error) => {
    logger.error(`Failed to dismiss main window: ${error}`);
  });
}

export function setWindowFocus() {
  return appWindow.setFocus();
}

export function setWindowAlwaysOnTop(alwaysOnTop: boolean) {
  return appWindow.setAlwaysOnTop(alwaysOnTop);
}

export async function moveWindowToTrayCenter() {
  await waitForWindowMoveEnd();
  isWindowMovingByPlugin = true;
  try {
    if (isTrayPositionSet) {
      await moveWindow(Position.TrayCenter);
    } else {
      await invoke("position_main_window_at_tray");
    }
  } finally {
    isWindowMovingByPlugin = false;
  }
}

export async function moveWindowToCenter() {
  await waitForWindowMoveEnd();
  logger.debug(`Moving window to center`);
  isWindowMovingByPlugin = true;
  await moveWindow(Position.Center);
  isWindowMovingByPlugin = false;
}

export async function moveWindowTo(x: number, y: number) {
  await waitForWindowMoveEnd();
  logger.debug(`Moving window to ${x}, ${y}`);
  isWindowMovingByPlugin = true;
  const position =
    currentPlatform === "macos" ? new LogicalPosition(x, y) : new PhysicalPosition(x, y);
  await appWindow.setPosition(position);
  isWindowMovingByPlugin = false;
}
