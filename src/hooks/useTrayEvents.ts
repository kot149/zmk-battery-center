import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TrayIcon, TrayIconEvent } from '@tauri-apps/api/tray';
import { Menu, Submenu, CheckMenuItem } from '@tauri-apps/api/menu';
import { isWindowVisible, showWindow, hideWindow, moveWindowToTrayCenter, setWindowFocus, setTrayPositionSet } from '@/utils/window';
import { exitApp } from '@/utils/common';
import { openUrl } from '@tauri-apps/plugin-opener';
import { logger } from '@/utils/log';
import { Config } from '@/utils/config';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

interface UseTrayEventsOptions {
    config: Config;
    isConfigLoaded: boolean;
    onManualWindowPositioningChange: (enabled: boolean) => void;
}

export function useTrayEvents({ config, isConfigLoaded, onManualWindowPositioningChange }: UseTrayEventsOptions) {
    const manualWindowPositioningRef = useRef(config.manualWindowPositioning);

    // Update ref when config changes
    useEffect(() => {
        manualWindowPositioningRef.current = config.manualWindowPositioning;
    }, [config.manualWindowPositioning]);

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
                                action: () => {
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

                                    onManualWindowPositioningChange(isChecked);
                                },
                            },
                        ]
                    },
                    {
                        id: 'licenses',
                        text: 'Licenses',
                        action: async () => {
                            let licensesWindow = await WebviewWindow.getByLabel('licenses');
                            if (!licensesWindow) {
                                licensesWindow = new WebviewWindow('licenses', {
                                    url: 'licenses.html',
                                    title: 'zmk-battery-center - Open Source Licenses',
                                    width: 600,
                                    height: 500,
                                    center: true,
                                    resizable: true,
                                    decorations: true,
                                });
                            }
                            await licensesWindow.show();
                            await licensesWindow.setFocus();
                        }
                    },
                    {
                        id: 'about',
                        text: 'About',
                        action: () => {
                            openUrl('https://github.com/kot149/zmk-battery-center');
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
    }, [isConfigLoaded, config.manualWindowPositioning, onManualWindowPositioningChange]);
}
