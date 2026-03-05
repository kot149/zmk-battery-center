use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

/// Generate safe filename from device name and BLE ID
fn safe_filename(device_name: &str, ble_id: &str) -> String {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    };
    format!("{}_{}.csv", sanitize(device_name), sanitize(ble_id))
}

/// Get path to battery_history directory
fn history_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        use std::env;
        let _ = app; // suppress unused warning in debug builds
        const DATA_DIR_ENV: &str = "ZMK_BATTERY_CENTER_DATA_DIR";
        const DEV_DATA_DIR: &str = ".dev-data";

        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
        let manifest_path = PathBuf::from(&manifest_dir);
        let project_root = manifest_path.parent().map(|p| p.to_path_buf()).unwrap_or(manifest_path);

        let base = if let Ok(dir) = env::var(DATA_DIR_ENV) {
            let p = PathBuf::from(&dir);
            if p.is_absolute() { p } else { project_root.join(&dir) }
        } else {
            project_root.join(DEV_DATA_DIR)
        };
        return base.join("battery_history");
    }

    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        app.path()
            .app_data_dir()
            .expect("failed to get app data dir")
            .join("battery_history")
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct BatteryHistoryRecord {
    pub timestamp: String,
    pub user_description: String,
    pub battery_level: i32,
}

/// Append battery history to CSV
#[tauri::command]
pub fn append_battery_history(
    app: tauri::AppHandle,
    device_name: String,
    ble_id: String,
    timestamp: String,
    user_description: String,
    battery_level: i32,
) -> Result<(), String> {
    let dir = history_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let filename = safe_filename(&device_name, &ble_id);
    let path = dir.join(&filename);

    let needs_header = !path.exists();

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    if needs_header {
        writeln!(file, "timestamp,user_description,battery_level").map_err(|e| e.to_string())?;
    }

    writeln!(file, "{},{},{}", timestamp, user_description, battery_level)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Read all battery history
#[tauri::command]
pub fn read_battery_history(
    app: tauri::AppHandle,
    device_name: String,
    ble_id: String,
) -> Result<Vec<BatteryHistoryRecord>, String> {
    let dir = history_dir(&app);
    let filename = safe_filename(&device_name, &ble_id);
    let path = dir.join(&filename);

    if !path.exists() {
        return Ok(vec![]);
    }

    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut is_first = true;

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if is_first {
            is_first = false;
            continue; // skip header
        }
        let parts: Vec<&str> = line.splitn(3, ',').collect();
        if parts.len() != 3 {
            continue;
        }
        let battery_level: i32 = parts[2].parse().unwrap_or(-1);
        records.push(BatteryHistoryRecord {
            timestamp: parts[0].to_string(),
            user_description: parts[1].to_string(),
            battery_level,
        });
    }

    Ok(records)
}
