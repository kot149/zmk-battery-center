use crate::tray_battery_payload::TrayBatteryPayload;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter,
};

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
        crate::tray_battery_macos::apply_tray_battery_state(&app, &tray, &payload)
    }
    #[cfg(all(
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        let tray = app
            .tray_by_id("tray_icon")
            .ok_or_else(|| "tray icon not found".to_string())?;
        crate::tray_battery_raster::apply_tray_battery_state(&app, &tray, &payload)
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (app, payload);
        Ok(())
    }
}

pub fn init_tray(app_handle: AppHandle) {
    let tray = app_handle.tray_by_id("tray_icon").unwrap();

    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
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

    #[cfg(all(
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        use tauri::Manager;
        if let Ok(icon_path) = app_handle
            .path()
            .resolve("icons/32x32.png", tauri::path::BaseDirectory::Resource)
        {
            if let Ok(icon) = tauri::image::Image::from_path(&icon_path) {
                let _ = tray.set_icon(Some(icon));
            }
        }
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
