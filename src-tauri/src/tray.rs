use crate::tray_battery_payload::TrayBatteryPayload;
#[cfg(target_os = "linux")]
use ksni::TrayMethods;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Manager,
};

pub struct TrayState {
    pub manual_positioning: AtomicBool,
    pub pin_window: AtomicBool,
    #[cfg(not(target_os = "linux"))]
    pub checks: std::sync::Mutex<
        Option<(
            tauri::menu::CheckMenuItem<tauri::Wry>,
            tauri::menu::CheckMenuItem<tauri::Wry>,
        )>,
    >,
    #[cfg(target_os = "linux")]
    pub tray_handle: Mutex<Option<ksni::Handle<LinuxTray>>>,
}

#[cfg(target_os = "linux")]
pub struct LinuxTray {
    app: AppHandle,
    icon: ksni::Icon,
}

#[cfg(target_os = "linux")]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        "zmk-battery-center".into()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        crate::window::toggle_main_window(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::*;

        let state = self.app.state::<TrayState>();
        let is_manual = state.manual_positioning.load(Ordering::Relaxed);
        let manual_label = if is_manual {
            "✔ Manual window positioning"
        } else {
            "  Manual window positioning"
        };
        let is_pinned = state.pin_window.load(Ordering::Relaxed);
        let pin_label = if is_pinned {
            "✔ Pin window"
        } else {
            "  Pin window"
        };

        vec![
            StandardItem {
                label: "Show".into(),
                activate: Box::new(|this: &mut Self| {
                    crate::window::show_main_window(&this.app);
                }),
                ..Default::default()
            }
            .into(),
            SubMenu {
                label: "Control".into(),
                submenu: vec![
                    StandardItem {
                        label: "Refresh window".into(),
                        activate: Box::new(|this: &mut Self| {
                            crate::window::refresh_main_window(&this.app);
                        }),
                        ..Default::default()
                    }
                    .into(),
                    StandardItem {
                        label: manual_label.into(),
                        activate: Box::new(|this: &mut Self| {
                            toggle_config(&this.app, "manualWindowPositioning");
                        }),
                        ..Default::default()
                    }
                    .into(),
                    StandardItem {
                        label: pin_label.into(),
                        activate: Box::new(|this: &mut Self| {
                            toggle_config(&this.app, "pinWindow");
                        }),
                        ..Default::default()
                    }
                    .into(),
                ],
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "About".into(),
                activate: Box::new(|this: &mut Self| {
                    crate::window::show_about_window(&this.app);
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit".into(),
                activate: Box::new(|this: &mut Self| {
                    this.app.exit(0);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

#[tauri::command]
pub fn update_tray_battery_icon(app: AppHandle, payload: TrayBatteryPayload) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let tray = app
            .tray_by_id("tray_icon")
            .ok_or_else(|| "tray icon not found".to_string())?;
        crate::tray_native_macos::apply_tray_battery_state(&app, &tray, &payload)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, payload);
        Ok(())
    }
}

#[tauri::command]
pub async fn update_manual_positioning(
    state: tauri::State<'_, TrayState>,
    enabled: bool,
) -> Result<(), String> {
    state.manual_positioning.store(enabled, Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        let handle_opt = {
            let guard = state.tray_handle.lock().unwrap();
            guard.clone()
        };
        if let Some(handle) = handle_opt {
            // Empty closure: TrayState is re-read inside menu(); calling update()
            // is what triggers ksni to rebuild the menu with the new state.
            let _ = handle.update(|_| {}).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_pin_window(
    state: tauri::State<'_, TrayState>,
    enabled: bool,
) -> Result<(), String> {
    state.pin_window.store(enabled, Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        let handle_opt = {
            let guard = state.tray_handle.lock().unwrap();
            guard.clone()
        };
        if let Some(handle) = handle_opt {
            let _ = handle.update(|_| {}).await;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn init_linux_tray(app_handle: AppHandle) {
    use tauri::image::Image;

    let tauri_image = match Image::from_bytes(include_bytes!("../icons/32x32.png")) {
        Ok(img) => img,
        Err(e) => {
            log::error!("init_linux_tray: failed to decode embedded tray icon: {e}");
            return;
        }
    };
    let width = tauri_image.width();
    let height = tauri_image.height();
    let rgba_bytes = tauri_image.rgba();

    let mut argb_bytes = rgba_bytes.to_vec();
    for pixel in argb_bytes.chunks_exact_mut(4) {
        pixel.rotate_right(1); // RGBA -> ARGB
    }

    let ksni_icon = ksni::Icon {
        width: width as i32,
        height: height as i32,
        data: argb_bytes,
    };

    let tray = LinuxTray {
        app: app_handle.clone(),
        icon: ksni_icon,
    };

    // Spawn the D-Bus StatusNotifierItem on the async runtime so we don't
    // block Tauri's setup hook; if D-Bus is unavailable (headless, no user
    // session, missing SNI host) we log and continue without a tray rather
    // than crashing the app.
    let app_handle_for_task = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        match tray.spawn().await {
            Ok(handle) => {
                let state = app_handle_for_task.state::<TrayState>();
                *state.tray_handle.lock().unwrap() = Some(handle);
            }
            Err(e) => {
                log::error!("init_linux_tray: failed to spawn D-Bus tray: {e}");
            }
        }
    });
}

fn toggle_config(app: &AppHandle, key: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let config = crate::monitor::current_config(&app);
        let enabled = !config[key].as_bool().unwrap_or(false);
        match crate::monitor::patch_config(&app, serde_json::json!({key: enabled})).await {
            Ok(_) if key == "manualWindowPositioning" => crate::window::show_main_window(&app),
            Ok(_) => {}
            Err(error) => log::error!("Failed to update {key}: {error}"),
        }
    });
}

pub fn sync_config(app: &AppHandle, config: &serde_json::Value) {
    let state = app.state::<TrayState>();
    let manual = config["manualWindowPositioning"].as_bool().unwrap_or(false);
    let pinned = config["pinWindow"].as_bool().unwrap_or(false);
    state.manual_positioning.store(manual, Ordering::Relaxed);
    state.pin_window.store(pinned, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(pinned);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some((manual_item, pin_item)) = state.checks.lock().unwrap().as_ref() {
        let _ = manual_item.set_checked(manual);
        let _ = pin_item.set_checked(pinned);
    };
    #[cfg(target_os = "linux")]
    {
        let handle = state.tray_handle.lock().unwrap().clone();
        if let Some(handle) = handle {
            tauri::async_runtime::spawn(async move {
                let _ = handle.update(|_| {}).await;
            });
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn init_native_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
    let config = crate::monitor::current_config(app);
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh window", true, None::<&str>)?;
    let manual = CheckMenuItem::with_id(
        app,
        "manual_window_positioning",
        "Manual window positioning",
        true,
        config["manualWindowPositioning"].as_bool().unwrap_or(false),
        None::<&str>,
    )?;
    let pin = CheckMenuItem::with_id(
        app,
        "pin_window",
        "Pin window",
        true,
        config["pinWindow"].as_bool().unwrap_or(false),
        None::<&str>,
    )?;
    let control =
        Submenu::with_id_and_items(app, "control", "Control", true, &[&refresh, &manual, &pin])?;
    let about = MenuItem::with_id(app, "about", "About", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &control, &about, &quit])?;
    if let Some(tray) = app.tray_by_id("tray_icon") {
        tray.set_menu(Some(menu))?;
        tray.set_show_menu_on_left_click(false)?;
        tray.on_menu_event(|app, event| match event.id.as_ref() {
            "show" => crate::window::show_main_window(app),
            "refresh" => crate::window::refresh_main_window(app),
            "manual_window_positioning" => toggle_config(app, "manualWindowPositioning"),
            "pin_window" => toggle_config(app, "pinWindow"),
            "about" => crate::window::show_about_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    }
    *app.state::<TrayState>().checks.lock().unwrap() = Some((manual, pin));
    Ok(())
}

pub fn init_tray(app_handle: AppHandle) {
    sync_config(&app_handle, &crate::monitor::current_config(&app_handle));
    #[cfg(not(target_os = "linux"))]
    if let Err(error) = init_native_menu(&app_handle) {
        log::error!("Failed to create tray menu: {error}");
    }
    #[cfg(target_os = "linux")]
    {
        init_linux_tray(app_handle.clone());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let Some(tray) = app_handle.tray_by_id("tray_icon") else {
            log::error!(
                "init_tray: tray icon 'tray_icon' not found; tray events will be unavailable"
            );
            return;
        };

        #[cfg(target_os = "macos")]
        {
            if let Ok(icon_path) = app_handle.path().resolve(
                "icons/icon_template.png",
                tauri::path::BaseDirectory::Resource,
            ) {
                if let Ok(icon) = tauri::image::Image::from_path(&icon_path) {
                    let _ = tray.set_icon(Some(icon));
                }
            }
            let _ = tray.set_icon_as_template(true);
        }

        tray.on_tray_icon_event(|tray_handle, event| {
            let app = tray_handle.app_handle();

            // Let positioner know about the event
            tauri_plugin_positioner::on_tray_event(app, &event);

            // Let frontend know about the event
            let _ = tauri::Emitter::emit(app, "tray_event", event.clone());
            app.state::<crate::window::WindowState>()
                .tray_position_known
                .store(true, Ordering::Relaxed);

            // Handle click event
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    crate::window::toggle_main_window(app);
                }
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } => {}
                _ => {}
            }
        });
    }
    if let Some(snapshot) = crate::monitor::current_snapshot() {
        if let Err(error) = crate::tray_battery_payload::refresh(&app_handle, &snapshot) {
            log::warn!("Failed to initialize battery tray icon: {error}");
        }
    }
}
