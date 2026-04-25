use crate::ble;
use tauri::AppHandle;

#[tauri::command]
pub async fn exit_app(app: AppHandle) {
    log::debug!("exit_app: hiding tray icon");
    if let Some(tray) = app.tray_by_id("tray_icon") {
        if let Err(e) = tray.set_visible(false) {
            log::warn!("exit_app: failed to hide tray icon: {e}");
        }
    }
    log::debug!("exit_app: stopping all BLE monitors");
    ble::stop_all_battery_monitors().await;
    log::debug!("exit_app: all BLE monitors stopped");
    log::debug!("exit_app: exiting");
    std::process::exit(0);
}
