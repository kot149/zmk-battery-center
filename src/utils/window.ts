import { LogicalPosition, LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { Position, moveWindow } from '@tauri-apps/plugin-positioner';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor } from '@tauri-apps/api/window';
import { isTrayPositionSet } from './tray';
import { invoke } from '@tauri-apps/api/core';
import { logger } from './log';
import { emit, once } from '@tauri-apps/api/event';
import { Config } from './config';
import { platform } from '@tauri-apps/plugin-os';

let isWindowMoving = false;
let isWindowMovingByPlugin = false;
let isWindowFocused = false;
let moveTimeout: NodeJS.Timeout | null = null;
let focusTimeout: NodeJS.Timeout | null = null;

async function waitForWindowMoveEnd(){
    while(isWindowMoving || isWindowMovingByPlugin){
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function saveWindowPosition(position?: { x: number, y: number }){
    if(!position){
        const window = getCurrentWebviewWindow();
        position = await window.position();
    }

    if (await platform() === 'macos'){
        // Convert logical position to physical position
        const monitor = await currentMonitor();
        const scaleFactor = monitor?.scaleFactor ?? 1;
        position = { x: position.x / scaleFactor, y: position.y / scaleFactor };
    }

    if(!isWindowMoving && !isWindowMovingByPlugin){
        await emit('update-config', { windowPosition: { x: position.x, y: position.y } });
        logger.info(`Window moved to tray center`);
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
        await saveWindowPosition();
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
    await saveWindowPosition();
}

export async function moveWindowTo(x: number, y: number) {
    await waitForWindowMoveEnd();
    const window = getCurrentWebviewWindow();
    logger.debug(`Moving window to ${x}, ${y}`);
    isWindowMovingByPlugin = true;
    const position = platform() === 'macos' ? new LogicalPosition(x, y) : new PhysicalPosition(x, y);
    await window.setPosition(position);
    isWindowMovingByPlugin = false;
    await saveWindowPosition();
}

// Move window to saved position on initial config load
once<Config>('config-changed', async ({ payload: initialConfig }) => {
	if(initialConfig.manualWindowPositioning){
		moveWindowTo(initialConfig.windowPosition.x, initialConfig.windowPosition.y);
	}
});

async function handleWindowEvent() {
    const window = getCurrentWebviewWindow();

    const unlistenOnMoved = window.onMoved(async ({ payload: position }) => {
        if(!isWindowMoving){
            logger.debug("Window move start");
        }
        isWindowMoving = true;

        if(moveTimeout){
            clearTimeout(moveTimeout);
        }

        moveTimeout = setTimeout(async () => {
            isWindowMoving = false;
            logger.debug("Window move end");

            if(!isWindowMovingByPlugin){
                await saveWindowPosition(position);
            }
        }, 200);
    });

    const unlistenOnFocusChanged = window.onFocusChanged(({ payload: isFocused }) => {
        isWindowFocused = isFocused;
        if(isFocused){
            logger.debug("Window focused");
        } else {
            logger.debug("Window focus lost");
        }

        if(!isWindowFocused && !isWindowMoving){
            if(focusTimeout) {
                clearTimeout(focusTimeout);
            }

            focusTimeout = setTimeout(() => {
                if(!isWindowFocused && !isWindowMoving){
                    hideWindow();
                    logger.debug("Hiding window");
                }
            }, 200);
        }
    });

    return async () => {
        (await unlistenOnMoved)();
        (await unlistenOnFocusChanged)();
    };
}

handleWindowEvent();
