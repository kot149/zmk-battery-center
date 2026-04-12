use csv::{ReaderBuilder, WriterBuilder};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
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

fn csv_record_line(timestamp: &str, user_description: &str, battery_level: i32) -> Result<String, String> {
    let mut buf = Vec::new();
    {
        let mut wtr = WriterBuilder::new()
            .has_headers(false)
            .from_writer(&mut buf);
        wtr.write_record([
            timestamp,
            user_description,
            &battery_level.to_string(),
        ])
        .map_err(|e| e.to_string())?;
        wtr.flush().map_err(|e| e.to_string())?;
    }
    let mut line = String::from_utf8(buf).map_err(|e| e.to_string())?;
    while line.ends_with('\n') || line.ends_with('\r') {
        line.pop();
    }
    Ok(line)
}

#[cfg(test)]
fn parse_history_record_line(line: &str) -> Option<BatteryHistoryRecord> {
    let mut rdr = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(std::io::Cursor::new(line.as_bytes()));
    let mut it = rdr.records();
    let rec = it.next()?.ok()?;
    if rec.len() != 3 {
        return None;
    }
    let battery_level: i32 = rec.get(2)?.parse().unwrap_or(-1);
    Some(BatteryHistoryRecord {
        timestamp: rec.get(0)?.to_string(),
        user_description: rec.get(1)?.to_string(),
        battery_level,
    })
}

fn append_battery_history_at_dir(
    dir: &std::path::Path,
    device_name: &str,
    ble_id: &str,
    timestamp: &str,
    user_description: &str,
    battery_level: i32,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let filename = safe_filename(device_name, ble_id);
    let path = dir.join(filename);

    let needs_header = !path.exists();

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    if needs_header {
        writeln!(file, "timestamp,user_description,battery_level").map_err(|e| e.to_string())?;
    }

    let line = csv_record_line(timestamp, user_description, battery_level)?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;

    Ok(())
}

fn read_battery_history_from_dir(
    dir: &std::path::Path,
    device_name: &str,
    ble_id: &str,
) -> Result<Vec<BatteryHistoryRecord>, String> {
    let filename = safe_filename(device_name, ble_id);
    let path = dir.join(filename);

    if !path.exists() {
        return Ok(vec![]);
    }

    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents).map_err(|e| e.to_string())?;

    let mut rdr = ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(std::io::Cursor::new(contents));

    let mut out = Vec::new();
    for result in rdr.records() {
        let rec = match result {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rec.len() != 3 {
            continue;
        }
        let battery_level: i32 = rec.get(2).unwrap_or("").parse().unwrap_or(-1);
        out.push(BatteryHistoryRecord {
            timestamp: rec.get(0).unwrap_or("").to_string(),
            user_description: rec.get(1).unwrap_or("").to_string(),
            battery_level,
        });
    }
    Ok(out)
}

#[cfg(debug_assertions)]
fn resolve_dev_history_dir(manifest_dir: Option<&str>, env_dir: Option<&str>) -> Option<PathBuf> {
    let manifest_dir = manifest_dir?;
    let manifest_path = PathBuf::from(manifest_dir);
    let project_root = manifest_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| manifest_path.clone());

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

    Some(base.join("battery_history"))
}

/// Get path to battery_history directory
fn history_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok();
        let env_dir = std::env::var(DATA_DIR_ENV).ok();
        if let Some(dir) = resolve_dev_history_dir(manifest_dir.as_deref(), env_dir.as_deref()) {
            return dir;
        }
    }

    use tauri::Manager;
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("battery_history")
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
    append_battery_history_at_dir(
        &dir,
        &device_name,
        &ble_id,
        &timestamp,
        &user_description,
        battery_level,
    )
}

/// Read all battery history
#[tauri::command]
pub fn read_battery_history(
    app: tauri::AppHandle,
    device_name: String,
    ble_id: String,
) -> Result<Vec<BatteryHistoryRecord>, String> {
    let dir = history_dir(&app);
    read_battery_history_from_dir(&dir, &device_name, &ble_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn safe_filename_sanitizes_non_filename_chars() {
        let filename = safe_filename("My Keyboard / Main", "AA:BB:CC");
        assert_eq!(filename, "My_Keyboard___Main_AA_BB_CC.csv");
    }

    #[test]
    fn csv_record_line_and_parser_roundtrip() {
        let line = csv_record_line("2026-03-19T12:34:56Z", "desk", 87).expect("serialize row");
        let parsed = parse_history_record_line(&line).expect("expected valid line");
        assert_eq!(parsed.timestamp, "2026-03-19T12:34:56Z");
        assert_eq!(parsed.user_description, "desk");
        assert_eq!(parsed.battery_level, 87);
    }

    #[test]
    fn csv_roundtrip_escapes_commas_and_quotes_in_text_fields() {
        let desc = "Left, \"quoted\" side";
        let line = csv_record_line("2026-03-19T12:34:56Z", desc, 42).expect("serialize row");
        let parsed = parse_history_record_line(&line).expect("parse row");
        assert_eq!(parsed.timestamp, "2026-03-19T12:34:56Z");
        assert_eq!(parsed.user_description, desc);
        assert_eq!(parsed.battery_level, 42);
    }

    #[test]
    fn read_battery_history_skips_malformed_rows() {
        let dir = tempdir().expect("create temp dir");
        let path = dir.path().join(safe_filename("Keyboard", "dev-1"));
        let csv = concat!(
            "timestamp,user_description,battery_level\n",
            "2026-03-19T00:00:00Z,office,90\n",
            "malformed-row-without-commas\n",
            "2026-03-19T01:00:00Z,home,75\n",
        );
        fs::write(&path, csv).expect("write csv");

        let records = read_battery_history_from_dir(dir.path(), "Keyboard", "dev-1").expect("read");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].battery_level, 90);
        assert_eq!(records[1].battery_level, 75);
    }

    #[test]
    fn append_and_read_supports_newline_inside_quoted_description() {
        let dir = tempdir().expect("create temp dir");
        let desc = "Central\nwith wrap";
        append_battery_history_at_dir(
            dir.path(),
            "Keyboard",
            "dev-1",
            "2026-03-19T12:00:00Z",
            desc,
            55,
        )
        .expect("append");
        let records = read_battery_history_from_dir(dir.path(), "Keyboard", "dev-1").expect("read");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].user_description, desc);
        assert_eq!(records[0].battery_level, 55);
    }

    #[test]
    fn parse_history_record_line_falls_back_for_invalid_battery_level() {
        let parsed = parse_history_record_line("2026-03-19T00:00:00Z,office,not-a-number")
            .expect("expected valid csv shape");
        assert_eq!(parsed.battery_level, -1);
    }

    #[test]
    fn read_battery_history_from_dir_returns_empty_when_file_missing() {
        let dir = tempdir().expect("create temp dir");
        let records = read_battery_history_from_dir(dir.path(), "Keyboard", "dev-1")
            .expect("read should succeed");
        assert!(records.is_empty());
    }

    #[test]
    fn append_and_read_battery_history_roundtrip() {
        let dir = tempdir().expect("create temp dir");

        append_battery_history_at_dir(
            dir.path(),
            "Keyboard",
            "dev-1",
            "2026-03-19T12:34:56Z",
            "Central",
            88,
        )
        .expect("append should succeed");
        append_battery_history_at_dir(
            dir.path(),
            "Keyboard",
            "dev-1",
            "2026-03-19T13:34:56Z",
            "Left",
            77,
        )
        .expect("append should succeed");

        let records = read_battery_history_from_dir(dir.path(), "Keyboard", "dev-1")
            .expect("read should succeed");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].user_description, "Central");
        assert_eq!(records[0].battery_level, 88);
        assert_eq!(records[1].user_description, "Left");
        assert_eq!(records[1].battery_level, 77);
    }

    #[test]
    fn append_battery_history_at_dir_writes_header_once() {
        let dir = tempdir().expect("create temp dir");

        append_battery_history_at_dir(
            dir.path(),
            "Keyboard",
            "dev-1",
            "2026-03-19T12:34:56Z",
            "Central",
            88,
        )
        .expect("append should succeed");
        append_battery_history_at_dir(
            dir.path(),
            "Keyboard",
            "dev-1",
            "2026-03-19T13:34:56Z",
            "Central",
            80,
        )
        .expect("append should succeed");

        let path = dir.path().join(safe_filename("Keyboard", "dev-1"));
        let content = fs::read_to_string(path).expect("read csv file");
        let header_count = content
            .lines()
            .filter(|line| *line == "timestamp,user_description,battery_level")
            .count();
        assert_eq!(header_count, 1);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_uses_relative_env_under_project_root() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), Some("local-data")).expect("path");
        let expected = PathBuf::from("/repo")
            .join("local-data")
            .join("battery_history");
        assert_eq!(path, expected);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_uses_absolute_env_path() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), Some("/tmp/dev-data")).expect("path");
        let expected = PathBuf::from("/tmp/dev-data").join("battery_history");
        assert_eq!(path, expected);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_falls_back_to_default_dir() {
        let path = resolve_dev_history_dir(Some("/repo/src-tauri"), None).expect("path");
        let expected = PathBuf::from("/repo")
            .join(DEV_DATA_DIR)
            .join("battery_history");
        assert_eq!(path, expected);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_history_dir_returns_none_without_manifest_dir() {
        assert!(resolve_dev_history_dir(None, Some("local-data")).is_none());
    }
}
