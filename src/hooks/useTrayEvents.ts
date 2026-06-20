import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TrayIcon, TrayIconEvent } from '@tauri-apps/api/tray';
import { Menu, Submenu, CheckMenuItem } from '@tauri-apps/api/menu';
import { isWindowVisible, showWindow, hideWindow, moveWindowToTrayCenter, setWindowFocus, setTrayPositionSet, moveWindowTo } from '@/utils/window';
import { exitApp } from '@/utils/common';
import { stopAllBatteryMonitors } from '@/utils/ble';
import { logger } from '@/utils/log';
import { Config } from '@/utils/config';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';

interface UseTrayEventsOptions {
    config: Config;
    isConfigLoaded: boolean;
    onManualWindowPositioningChange: (enabled: boolean) => void;
}

export function useTrayEvents({ config, isConfigLoaded, onManualWindowPositioningChange }: UseTrayEventsOptions) {
    const configRef = useRef(config);
    configRef.current = config;

    const onManualWindowPositioningChangeRef = useRef(onManualWindowPositioningChange);
    onManualWindowPositioningChangeRef.current = onManualWindowPositioningChange;

    // Synchronize backend state whenever manualWindowPositioning config changes
    useEffect(() => {
        if (!isConfigLoaded) return;
        if (platform() === 'linux') {
            invoke('update_manual_positioning', { enabled: config.manualWindowPositioning })
                .catch(err => logger.error(`Failed to update manual positioning in backend: ${err}`));
        }
    }, [config.manualWindowPositioning, isConfigLoaded]);

    useEffect(() => {
        if (!isConfigLoaded) return;

        let unlistenTrayEvent: (() => void) | null = null;
        let unlistenTrayLeftClick: (() => void) | null = null;
        let unlistenTrayMenuRefresh: (() => void) | null = null;
        let unlistenTrayMenuToggleManual: (() => void) | null = null;
        let unlistenTrayMenuAbout: (() => void) | null = null;

        const showWindowAtConfiguredPosition = async (manualOverride?: boolean) => {
            const manual = manualOverride ?? configRef.current.manualWindowPositioning;
            showWindow();
            if (!manual) {
                moveWindowToTrayCenter();
            } else {
                await moveWindowTo(configRef.current.windowPosition.x, configRef.current.windowPosition.y);
            }
        };

        const openAboutWindow = async () => {
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
        };

        const setupTray = async () => {
            const isLinux = platform() === 'linux';
            const tray = isLinux ? null : await TrayIcon.getById('tray_icon');
            if (!isLinux && !tray) {
                logger.error('Tray icon not found');
                return;
            }

            // Set tray position flag on first tray event
            let isTrayPositionSet = false;
            if (tray) {
                unlistenTrayEvent = await listen<TrayIconEvent>('tray_event', () => {
                    if (!isTrayPositionSet) {
                        isTrayPositionSet = true;
                        setTrayPositionSet(true);
                        logger.info('Tray position set');
                    }
                });
            }

            // Handle tray left click
            unlistenTrayLeftClick = await listen('tray_left_click', async () => {
                const isVisible = await isWindowVisible();
                if (isVisible) {
                    hideWindow();
                } else {
                    await showWindowAtConfiguredPosition();
                    setWindowFocus();
                }
            });

            // Create tray menu
            const menu = await Menu.new({
                items: [
                    {
                        id: 'show',
                        text: 'Show',
                        action: async () => {
                            await showWindowAtConfiguredPosition();
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
                                    await showWindowAtConfiguredPosition();
                                },
                            },
                            {
                                id: 'manual_window_positioning',
                                text: 'Manual window positioning',
                                checked: configRef.current.manualWindowPositioning,
                                action: async (trayId: string) => {
                                    const controlMenu = await menu?.get('control') as Submenu | null;
                                    const thisMenu = await controlMenu?.get(trayId) as CheckMenuItem | null;
                                    if (!thisMenu) return;

                                    const isChecked = await thisMenu.isChecked();
                                    await showWindowAtConfiguredPosition(isChecked);

                                    onManualWindowPositioningChangeRef.current(isChecked);
                                },
                            },
                        ]
                    },
                    {
                        id: 'about',
                        text: 'About',
                        action: openAboutWindow,
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

            if (platform() !== 'linux') {
                if (tray) {
                    await tray.setMenu(menu);
                    await tray.setShowMenuOnLeftClick(false);
                }
            } else {
                // Initialize Rust state
                await invoke('update_manual_positioning', { enabled: configRef.current.manualWindowPositioning });

                unlistenTrayMenuRefresh = await listen('tray_menu_refresh', async () => {
                    await stopAllBatteryMonitors();
                    location.reload();
                    await showWindowAtConfiguredPosition();
                });

                unlistenTrayMenuToggleManual = await listen('tray_menu_toggle_manual_positioning', async () => {
                    const isChecked = !configRef.current.manualWindowPositioning;
                    await showWindowAtConfiguredPosition(isChecked);
                    onManualWindowPositioningChangeRef.current(isChecked);
                    await invoke('update_manual_positioning', { enabled: isChecked });
                });

                unlistenTrayMenuAbout = await listen('tray_menu_about', openAboutWindow);
            }
        };

        setupTray();

        return () => {
            if (unlistenTrayEvent) unlistenTrayEvent();
            if (unlistenTrayLeftClick) unlistenTrayLeftClick();
            if (unlistenTrayMenuRefresh) unlistenTrayMenuRefresh();
            if (unlistenTrayMenuToggleManual) unlistenTrayMenuToggleManual();
            if (unlistenTrayMenuAbout) unlistenTrayMenuAbout();
        };
    }, [isConfigLoaded]);
}
