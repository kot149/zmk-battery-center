use crate::ble;

#[tauri::command]
pub async fn exit_app() {
    log::debug!("exit_app: stopping all BLE monitors");
    ble::stop_all_battery_monitors().await;
    log::debug!("exit_app: all BLE monitors stopped, exiting");
    std::process::exit(0);
}
