use tauri;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub fn init_tray(app_handle: AppHandle) {
    let tray = app_handle.tray_by_id("tray_icon").unwrap();

    #[cfg(target_os = "macos")]
    {
        if let Ok(icon_path) = app_handle
            .path()
            .resolve("icons/icon_template.png", tauri::path::BaseDirectory::Resource)
        {
            if let Ok(icon) = Image::from_path(&icon_path) {
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
            _ => {}
        }
    });
}
