use crate::ble;
use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[tauri::command]
pub async fn exit_app(app: AppHandle) {
    log::debug!("exit_app: hiding tray icon");
    if let Some(tray) = app.tray_by_id("tray_icon") {
        if let Err(e) = tray.set_visible(false) {
            log::warn!("exit_app: failed to hide tray icon: {e}");
        }
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
    log::debug!("exit_app: stopping all BLE monitors");
    ble::stop_all_battery_monitors().await;
    log::debug!("exit_app: all BLE monitors stopped");
    log::debug!("exit_app: exiting");
    app.exit(0);
}
