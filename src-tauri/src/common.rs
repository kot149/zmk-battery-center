#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}
