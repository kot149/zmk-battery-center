use crate::tray_battery_payload::TrayBatteryPayload;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
#[cfg(target_os = "linux")]
use ksni::TrayMethods;

pub struct TrayState {
    pub manual_positioning: AtomicBool,
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
        let _ = self.app.emit("tray_left_click", ());
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

        vec![
            StandardItem {
                label: "Show".into(),
                activate: Box::new(|this: &mut Self| {
                    let _ = this.app.emit("tray_left_click", ());
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
                            let _ = this.app.emit("tray_menu_refresh", ());
                        }),
                        ..Default::default()
                    }
                    .into(),
                    StandardItem {
                        label: manual_label.into(),
                        activate: Box::new(|this: &mut Self| {
                            let _ = this.app.emit("tray_menu_toggle_manual_positioning", ());
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
                    let _ = this.app.emit("tray_menu_about", ());
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
pub fn update_tray_battery_icon(
    app: AppHandle,
    payload: TrayBatteryPayload,
) -> Result<(), String> {
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
            let _ = handle.update(|_| {}).await;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn init_linux_tray(app_handle: AppHandle) {
    use tauri::image::Image;

    let tauri_image = Image::from_bytes(include_bytes!("../icons/32x32.png")).unwrap();
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

    let handle = tauri::async_runtime::block_on(tray.spawn()).unwrap();

    let state = app_handle.state::<TrayState>();
    *state.tray_handle.lock().unwrap() = Some(handle);
}

pub fn init_tray(app_handle: AppHandle) {
    #[cfg(target_os = "linux")]
    {
        init_linux_tray(app_handle);
    }

    #[cfg(not(target_os = "linux"))]
    {
        let tray = app_handle.tray_by_id("tray_icon").unwrap();

        #[cfg(target_os = "macos")]
        {
            if let Ok(icon_path) = app_handle
                .path()
                .resolve("icons/icon_template.png", tauri::path::BaseDirectory::Resource)
            {
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
            let _ = app.emit("tray_event", event.clone());

            // Handle click event
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let _ = app.emit("tray_left_click", event.clone());
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
}
