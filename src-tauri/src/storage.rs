use std::path::PathBuf;

const DEV_DATA_DIR: &str = ".dev-data";
const DATA_DIR_ENV: &str = "ZMK_BATTERY_CENTER_DATA_DIR";

#[tauri::command]
pub fn get_dev_store_path() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok()?;
        let manifest_path = PathBuf::from(&manifest_dir);
        let project_root = manifest_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| manifest_path.clone());

        let dev_data = if let Ok(ref dir) = std::env::var(DATA_DIR_ENV) {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                path
            } else {
                project_root.join(dir)
            }
        } else {
            project_root.join(DEV_DATA_DIR)
        };

        Some(dev_data.to_string_lossy().to_string())
    }

    #[cfg(not(debug_assertions))]
    {
        None
    }
}
