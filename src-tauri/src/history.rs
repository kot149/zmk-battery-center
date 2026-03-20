use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

#[cfg(debug_assertions)]
const DATA_DIR_ENV: &str = "ZMK_BATTERY_CENTER_DATA_DIR";
#[cfg(debug_assertions)]
const DEV_DATA_DIR: &str = ".dev-data";

/// Generate safe filename from device name and BLE ID
fn safe_filename(device_name: &str, ble_id: &str) -> String {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    format!("{}_{}.csv", sanitize(device_name), sanitize(ble_id))
}

fn csv_record_line(timestamp: &str, user_description: &str, battery_level: i32) -> String {
    format!("{timestamp},{user_description},{battery_level}")
}

fn parse_history_record_line(line: &str) -> Option<BatteryHistoryRecord> {
    let parts: Vec<&str> = line.splitn(3, ',').collect();
    if parts.len() != 3 {
        return None;
    }

    let battery_level: i32 = parts[2].parse().unwrap_or(-1);
    Some(BatteryHistoryRecord {
        timestamp: parts[0].to_string(),
        user_description: parts[1].to_string(),
        battery_level,
    })
}

fn parse_history_lines(lines: Vec<String>) -> Vec<BatteryHistoryRecord> {
    lines
        .into_iter()
        .enumerate()
        .filter_map(|(index, line)| {
            if index == 0 {
                return None;
            }
            parse_history_record_line(&line)
        })
        .collect()
}

#[cfg(debug_assertions)]
fn resolve_dev_history_dir(manifest_dir: Option<&str>, env_dir: Option<&str>) -> PathBuf {
    let manifest_path = PathBuf::from(manifest_dir.unwrap_or_default());
    let project_root = manifest_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest_path);

    let base = if let Some(dir) = env_dir {
        let p = PathBuf::from(dir);
        if p.is_absolute() {
            p
        } else {
            project_root.join(dir)
        }
    } else {
        project_root.join(DEV_DATA_DIR)
    };

    base.join("battery_history")
}

/// Get path to battery_history directory
fn history_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app; // suppress unused warning in debug builds
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok();
        let env_dir = std::env::var(DATA_DIR_ENV).ok();
        return resolve_dev_history_dir(manifest_dir.as_deref(), env_dir.as_deref());
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

    writeln!(
        file,
        "{}",
        csv_record_line(&timestamp, &user_description, battery_level)
    )
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
    let mut lines = Vec::new();
    for line in reader.lines() {
        lines.push(line.map_err(|e| e.to_string())?);
    }

    Ok(parse_history_lines(lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_sanitizes_non_filename_chars() {
        let filename = safe_filename("My Keyboard / Main", "AA:BB:CC");
        assert_eq!(filename, "My_Keyboard___Main_AA_BB_CC.csv");
    }

    #[test]
    fn csv_record_line_and_parser_roundtrip() {
        let line = csv_record_line("2026-03-19T12:34:56Z", "desk", 87);
        let parsed = parse_history_record_line(&line).expect("expected valid line");
        assert_eq!(parsed.timestamp, "2026-03-19T12:34:56Z");
        assert_eq!(parsed.user_description, "desk");
        assert_eq!(parsed.battery_level, 87);
    }

    #[test]
    fn parse_history_lines_skips_header_and_malformed_rows() {
        let lines = vec![
            "timestamp,user_description,battery_level".to_string(),
            "2026-03-19T00:00:00Z,office,90".to_string(),
            "malformed-row-without-commas".to_string(),
            "2026-03-19T01:00:00Z,home,75".to_string(),
        ];

        let records = parse_history_lines(lines);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].battery_level, 90);
        assert_eq!(records[1].battery_level, 75);
    }

    #[test]
    fn parse_history_record_line_falls_back_for_invalid_battery_level() {
        let parsed = parse_history_record_line("2026-03-19T00:00:00Z,office,not-a-number")
            .expect("expected valid csv shape");
        assert_eq!(parsed.battery_level, -1);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_uses_relative_env_under_project_root() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), Some("local-data"));
        let expected = PathBuf::from("/repo")
            .join("local-data")
            .join("battery_history");
        assert_eq!(path, expected);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_uses_absolute_env_path() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), Some("/tmp/dev-data"));
        let expected = PathBuf::from("/tmp/dev-data").join("battery_history");
        assert_eq!(path, expected);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_falls_back_to_default_dir() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), None);
        let expected = PathBuf::from("/repo")
            .join(DEV_DATA_DIR)
            .join("battery_history");
        assert_eq!(path, expected);
    }
}
