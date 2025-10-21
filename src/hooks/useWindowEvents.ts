import { useEffect, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { logger } from '@/utils/log';
import { Config } from '@/utils/config';
import { hideWindow, moveWindowTo, getIsWindowMovingByPlugin } from '@/utils/window';
import { platform } from '@tauri-apps/plugin-os';
import { currentMonitor } from '@tauri-apps/api/window';

interface UseWindowEventsOptions {
    config: Config;
    isConfigLoaded: boolean;
    onWindowPositionChange: (position: { x: number; y: number }) => void;
}

export function useWindowEvents({ config, isConfigLoaded, onWindowPositionChange }: UseWindowEventsOptions) {
    const isWindowMovingRef = useRef(false);
    const isWindowFocusedRef = useRef(false);
    const moveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const hasRestoredPositionRef = useRef(false);

    // Restore window position on initial config load
    useEffect(() => {
        if (isConfigLoaded && !hasRestoredPositionRef.current && config.manualWindowPositioning) {
            hasRestoredPositionRef.current = true;
            moveWindowTo(config.windowPosition.x, config.windowPosition.y).catch(err => {
                logger.error(`Failed to restore window position: ${err}`);
            });
        }
    }, [isConfigLoaded, config.manualWindowPositioning, config.windowPosition.x, config.windowPosition.y]);

    // Handle window events
    useEffect(() => {
        const window = getCurrentWebviewWindow();
        let unlistenOnMoved: (() => void) | null = null;
        let unlistenOnFocusChanged: (() => void) | null = null;

        const saveWindowPosition = async (position: { x: number; y: number }) => {
            if (await platform() === 'macos') {
                // Convert logical position to physical position
                const monitor = await currentMonitor();
                const scaleFactor = monitor?.scaleFactor ?? 1;
                position = { x: position.x / scaleFactor, y: position.y / scaleFactor };
            }

            if (!isWindowMovingRef.current && !getIsWindowMovingByPlugin()) {
                onWindowPositionChange(position);
                logger.info(`Window position saved: ${position.x}, ${position.y}`);
            }
        };

        const setupListeners = async () => {
            unlistenOnMoved = await window.onMoved(async ({ payload: position }) => {
                if (!isWindowMovingRef.current) {
                    logger.debug("Window move start");
                }
                isWindowMovingRef.current = true;

                if (moveTimeoutRef.current) {
                    clearTimeout(moveTimeoutRef.current);
                }

                moveTimeoutRef.current = setTimeout(async () => {
                    isWindowMovingRef.current = false;
                    logger.debug("Window move end");

                    if (!getIsWindowMovingByPlugin()) {
                        await saveWindowPosition(position);
                    }
                }, 200);
            });

            unlistenOnFocusChanged = await window.onFocusChanged(({ payload: isFocused }) => {
                isWindowFocusedRef.current = isFocused;
                if (isFocused) {
                    logger.debug("Window focused");
                } else {
                    logger.debug("Window focus lost");
                }

                if (!isWindowFocusedRef.current && !isWindowMovingRef.current) {
                    if (focusTimeoutRef.current) {
                        clearTimeout(focusTimeoutRef.current);
                    }

                    focusTimeoutRef.current = setTimeout(() => {
                        if (!isWindowFocusedRef.current && !isWindowMovingRef.current) {
                            hideWindow();
                            logger.debug("Hiding window");
                        }
                    }, 200);
                }
            });
        };

        setupListeners();

        return () => {
            if (unlistenOnMoved) unlistenOnMoved();
            if (unlistenOnFocusChanged) unlistenOnFocusChanged();
            if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);
            if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
        };
    }, [onWindowPositionChange]);
}
