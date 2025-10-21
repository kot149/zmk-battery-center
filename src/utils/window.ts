import { LogicalPosition, LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { Position, moveWindow } from '@tauri-apps/plugin-positioner';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { logger } from './log';
import { platform } from '@tauri-apps/plugin-os';

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

async function waitForWindowMoveEnd(){
    while(isWindowMovingByPlugin){
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

export async function resizeWindow(x: number, y: number) {
	logger.info(`resizeWindow: ${x}x${y}`);
    const scaleFactor = await invoke<number>('get_windows_text_scale_factor');
    const width = x * scaleFactor;
    const height = y * scaleFactor;
    logger.info(`scaled size: ${width}x${height}`);

	const window = getCurrentWebviewWindow();
	if (window) {
		window.setSize(new LogicalSize(width, height));
	}
}

export async function resizeWindowToContent() {
    const width = document.getElementById('app')?.clientWidth ?? 0;
    const height = document.getElementById('app')?.clientHeight ?? 0;
    resizeWindow(width, height);
}

export function isWindowVisible() {
    return getCurrentWebviewWindow().isVisible();
}

export function showWindow() {
    getCurrentWebviewWindow().show();
}

export function hideWindow() {
    getCurrentWebviewWindow().hide();
}

export function setWindowFocus() {
    getCurrentWebviewWindow().setFocus();
}

export async function moveWindowToTrayCenter() {
    if(isTrayPositionSet){
        await waitForWindowMoveEnd();
        logger.debug(`Moving window to tray center`);
        isWindowMovingByPlugin = true;
        await moveWindow(Position.TrayCenter);
        isWindowMovingByPlugin = false;
    } else {
        logger.warn(`Skipped moving window to tray center because tray position is not set`);
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
    const window = getCurrentWebviewWindow();
    logger.debug(`Moving window to ${x}, ${y}`);
    isWindowMovingByPlugin = true;
    const position = await platform() === 'macos' ? new LogicalPosition(x, y) : new PhysicalPosition(x, y);
    await window.setPosition(position);
    isWindowMovingByPlugin = false;
}
