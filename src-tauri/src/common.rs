use crate::ble;
use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[tauri::command]
pub async fn exit_app(app: AppHandle) {
    log::debug!("event=exit_request step=hide_tray_icon");
    if let Some(tray) = app.tray_by_id("tray_icon")
        && let Err(e) = tray.set_visible(false)
    {
        log::warn!("event=tray_icon_hide_failed error={e}");
    }
    #[cfg(target_os = "linux")]
    {
        let handle = app
            .state::<crate::tray::TrayState>()
            .tray_handle
            .lock()
            .unwrap()
            .take();
        if let Some(handle) = handle {
            handle.shutdown().await;
        }
    }
    log::debug!("event=exit_request step=stop_ble_monitors");
    ble::stop_all_battery_monitors().await;
    log::debug!("event=ble_monitors_stopped");
    log::debug!("event=exit");
    app.exit(0);
}
