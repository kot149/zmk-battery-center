import { LogicalSize } from '@tauri-apps/api/dpi';
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TrayIcon, TrayIconEvent } from '@tauri-apps/api/tray';
import { Menu, Submenu, CheckMenuItem } from '@tauri-apps/api/menu';
import { isWindowVisible, showWindow, hideWindow, moveWindowToTrayCenter, setWindowFocus, setTrayPositionSet } from '@/utils/window';
import { exitApp } from '@/utils/common';
import { stopAllBatteryMonitors } from '@/utils/ble';
import { logger } from '@/utils/log';
import { Config } from '@/utils/config';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalSize } from '@tauri-apps/api/dpi';

interface UseTrayEventsOptions {
    config: Config;
    isConfigLoaded: boolean;
    onManualWindowPositioningChange: (enabled: boolean) => void;
}

export function useTrayEvents({ config, isConfigLoaded, onManualWindowPositioningChange }: UseTrayEventsOptions) {
    const manualWindowPositioningRef = useRef(config.manualWindowPositioning);
    const onManualWindowPositioningChangeRef = useRef(onManualWindowPositioningChange);

    manualWindowPositioningRef.current = config.manualWindowPositioning;
    onManualWindowPositioningChangeRef.current = onManualWindowPositioningChange;

    useEffect(() => {
        if (!isConfigLoaded) return;

        let unlistenTrayEvent: (() => void) | null = null;
        let unlistenTrayLeftClick: (() => void) | null = null;

        const setupTray = async () => {
            const tray = await TrayIcon.getById('tray_icon');
            if (!tray) {
                logger.error('Tray icon not found');
                return;
            }

            // Set tray position flag on first tray event
            let isTrayPositionSet = false;
            unlistenTrayEvent = await listen<TrayIconEvent>('tray_event', () => {
                if (!isTrayPositionSet) {
                    isTrayPositionSet = true;
                    setTrayPositionSet(true);
                    logger.info('Tray position set');
                }
            });

            // Handle tray left click
            unlistenTrayLeftClick = await listen('tray_left_click', async () => {
                const isVisible = await isWindowVisible();
                if (isVisible) {
                    hideWindow();
                } else {
                    showWindow();
                    if (!manualWindowPositioningRef.current) {
                        moveWindowToTrayCenter();
                    }
                    setWindowFocus();
                }
            });

            // Create tray menu
            const menu = await Menu.new({
                items: [
                    {
                        id: 'show',
                        text: 'Show',
                        action: () => {
                            showWindow();
                            if (!manualWindowPositioningRef.current) {
                                moveWindowToTrayCenter();
                            }
                        }
                    },
                    {
                        id: 'control',
                        text: 'Control',
                        items: [
                            {
                                id: 'refresh',
                                text: 'Refresh window',
                                action: async () => {
                                    await stopAllBatteryMonitors();
                                    location.reload();
                                    showWindow();
                                    if (!manualWindowPositioningRef.current) {
                                        moveWindowToTrayCenter();
                                    }
                                },
                            },
                            {
                                id: 'manual_window_positioning',
                                text: 'Manual window positioning',
                                checked: config.manualWindowPositioning,
                                action: async (trayId: string) => {
                                    const controlMenu = await menu?.get('control') as Submenu | null;
                                    const thisMenu = await controlMenu?.get(trayId) as CheckMenuItem | null;
                                    if (!thisMenu) return;

                                    const isChecked = await thisMenu.isChecked();
                                    manualWindowPositioningRef.current = isChecked;
                                    showWindow();
                                    if (!manualWindowPositioningRef.current) {
                                        moveWindowToTrayCenter();
                                    }

                                    onManualWindowPositioningChangeRef.current(isChecked);
                                },
                            },
                        ]
                    },
                    {
                        id: 'about',
                        text: 'About',
                        action: async () => {
                            let aboutWindow = await WebviewWindow.getByLabel('about');
                            if (!aboutWindow) {
                                aboutWindow = new WebviewWindow('about', {
                                    url: 'about.html',
                                    title: 'zmk-battery-center - About',
                                    width: 600,
                                    height: 500,
                                    center: true,
                                    resizable: true,
                                    decorations: true,
                                });
                            }
                            await aboutWindow.show();
                            await aboutWindow.setFocus();
                        }
                    },
                    {
                        id: 'quit',
                        text: 'Quit',
                        action: () => {
                            exitApp();
                        }
                    }
                ]
            });

            tray.setMenu(menu);
            tray.setShowMenuOnLeftClick(false);
        };

        setupTray();

        return () => {
            if (unlistenTrayEvent) unlistenTrayEvent();
            if (unlistenTrayLeftClick) unlistenTrayLeftClick();
        };
    }, [isConfigLoaded]);
}
