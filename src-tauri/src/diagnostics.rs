use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::BuildHasher;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

mod log_file;

const LOG_NAME: &str = "zmk-battery-center";
const LOG_LIMIT: usize = 2 * 1024 * 1024;
static IDENTITIES: RwLock<Vec<(String, String)>> = RwLock::new(Vec::new());
static HASHER: OnceLock<RandomState> = OnceLock::new();
static SESSION: OnceLock<String> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    pub fn default_level() -> Self {
        if cfg!(debug_assertions) {
            Self::Debug
        } else {
            Self::Warn
        }
    }

    fn filter(self) -> log::LevelFilter {
        match self {
            Self::Warn => log::LevelFilter::Warn,
            Self::Info => log::LevelFilter::Info,
            Self::Debug => log::LevelFilter::Debug,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct LogLevelState {
    level: LogLevel,
    generation: u64,
}

impl LogLevelState {
    fn update(&mut self, level: LogLevel) -> bool {
        if self.level == level {
            return false;
        }
        self.level = level;
        self.generation += 1;
        true
    }
}

pub struct Diagnostics {
    state: Mutex<LogLevelState>,
    log_dir: PathBuf,
}

pub fn config_level(config: &Value) -> Result<LogLevel, String> {
    match config.get("logLevel") {
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string()),
        None => Ok(LogLevel::default_level()),
    }
}

pub fn device_ref(id: &str) -> String {
    format!(
        "device-{:016x}",
        HASHER.get_or_init(RandomState::new).hash_one(id)
    )
}

pub fn update_identities(devices: &[crate::monitor::MonitorDevice]) {
    let mut values = IDENTITIES.write().unwrap_or_else(|e| e.into_inner());
    values.clear();
    for device in devices {
        let alias = device_ref(&device.id);
        for value in [
            Some(&device.id),
            Some(&device.name),
            device.display_name.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if !value.is_empty() {
                values.push((value.clone(), alias.clone()));
            }
        }
    }
    values.sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
}

fn redact(message: &str) -> String {
    let identities = IDENTITIES.read().unwrap_or_else(|e| e.into_inner());
    let mut text = String::with_capacity(message.len());
    let mut rest = message;
    while !rest.is_empty() {
        if let Some((value, alias)) = identities.iter().find(|(value, _)| rest.starts_with(value)) {
            text.push_str(alias);
            rest = &rest[value.len()..];
        } else {
            let character = rest.chars().next().unwrap();
            text.push(character);
            rest = &rest[character.len_utf8()..];
        }
    }
    drop(identities);
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(key)
            && !home.is_empty()
        {
            text = text.replace(&home, "<home>");
        }
    }
    text = redact_keys(&text);
    let mut output = String::with_capacity(text.len());
    for part in text.split_inclusive(|c: char| !(c.is_ascii_hexdigit() || c == '-' || c == ':')) {
        let token =
            part.trim_end_matches(|c: char| !(c.is_ascii_hexdigit() || c == '-' || c == ':'));
        let mac = token.len() == 17
            && token.split([':', '-']).count() == 6
            && token
                .split([':', '-'])
                .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()));
        if mac || (token.len() == 36 && uuid::Uuid::parse_str(token).is_ok()) {
            output.push_str(&device_ref(token));
            output.push_str(&part[token.len()..]);
        } else {
            output.push_str(part);
        }
    }
    output
}

fn redact_keys(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let key_len = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        let key = &rest[..key_len];
        if [
            "id",
            "device_id",
            "deviceId",
            "name",
            "device_name",
            "display_name",
            "displayName",
        ]
        .contains(&key)
        {
            let suffix = &rest[key_len..];
            let suffix = suffix.strip_prefix('"').unwrap_or(suffix).trim_start();
            if let Some(value) = suffix.strip_prefix(['=', ':']) {
                let value = value.trim_start();
                let quote = value.starts_with('"');
                let value_start = if quote { &value[1..] } else { value };
                let end = value_start
                    .find(|c: char| {
                        if quote {
                            c == '"'
                        } else {
                            c.is_whitespace() || [',', '}', ']'].contains(&c)
                        }
                    })
                    .unwrap_or(value_start.len());
                let raw = &value_start[..end];
                if !raw.is_empty() && !raw.starts_with("device-") && raw != "null" {
                    let prefix_len = rest.len() - value_start.len();
                    output.push_str(&rest[..prefix_len]);
                    output.push_str(&device_ref(raw));
                    rest = &value_start[end..];
                    continue;
                }
            }
        }
        if key_len > 0 {
            output.push_str(key);
            rest = &rest[key_len..];
        } else {
            let character = rest.chars().next().unwrap();
            // Strip terminal escapes from the file log.
            if character == '\u{1b}' && rest.starts_with("\u{1b}[") {
                let end = rest[2..]
                    .find(|c: char| c.is_ascii_alphabetic())
                    .map(|p| p + 3)
                    .unwrap_or(rest.len());
                rest = &rest[end..];
            } else {
                output.push(character);
                rest = &rest[character.len_utf8()..];
            }
        }
    }
    output
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_log::{Target, TargetKind};
    let log_dir = if cfg!(debug_assertions) {
        crate::storage::resolve_store_file_path(app, "logs")?
    } else {
        app.path().app_log_dir().map_err(|e| e.to_string())?
    };
    SESSION.get_or_init(|| format!("{:x}-{}", now_ms(), std::process::id()));
    let file_lock = Arc::new(Mutex::new(()));
    let writer = log_file::LogFile::new(log_dir.clone(), LOG_NAME, LOG_LIMIT as u64, file_lock)
        .map_err(|e| e.to_string())?;
    app.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Warn)
            .level_for("zmk_battery_center_lib", log::LevelFilter::Debug)
            .level_for(tauri_plugin_log::WEBVIEW_TARGET, log::LevelFilter::Debug)
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::Dispatch(
                    fern::Dispatch::new().chain(fern::Output::writer(Box::new(writer), "\n")),
                )),
            ])
            .format(|out, message, record| {
                out.finish(format_args!(
                    "{} [{}] [{}] boot={} {}",
                    timestamp(time::OffsetDateTime::now_utc()),
                    record.target(),
                    record.level(),
                    SESSION.get().map(String::as_str).unwrap_or("unknown"),
                    redact(&message.to_string())
                ))
            })
            .build(),
    )
    .map_err(|e| e.to_string())?;
    log::set_max_level(log::LevelFilter::Warn);
    app.manage(Diagnostics {
        state: Mutex::new(LogLevelState {
            level: LogLevel::default_level(),
            generation: 0,
        }),
        log_dir,
    });
    Ok(())
}

pub fn apply_config(app: &AppHandle, config: &Value) {
    let Some(diagnostics) = app.try_state::<Diagnostics>() else {
        return;
    };
    let level = config_level(config).expect("validated log level");
    let (changed, state) = {
        let mut state = diagnostics.state.lock().unwrap_or_else(|e| e.into_inner());
        let changed = state.update(level);
        log::set_max_level(level.filter());
        (changed, *state)
    };
    if changed {
        if crate::window::main_window_requested(app) {
            let _ = app.emit_to("main", "log-level-changed", state);
        }
        if let Some(window) = app.get_webview_window("about")
            && window.is_visible().unwrap_or(false)
        {
            let _ = app.emit_to("about", "log-level-changed", state);
        }
    }
    log::info!(
        "event=logging_configured version={} os={} level={level:?} monitoring={}",
        app.package_info().version,
        std::env::consts::OS,
        config["fetchInterval"]
    );
}

#[tauri::command]
pub fn get_log_level_state(app: AppHandle) -> LogLevelState {
    *app.state::<Diagnostics>()
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub async fn set_log_level(app: AppHandle, level: LogLevel) -> Result<LogLevelState, String> {
    crate::monitor::monitor_update_config(json!({"logLevel": level})).await?;
    Ok(get_log_level_state(app))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppFolder {
    Logs,
    Data,
}

#[tauri::command]
pub fn open_app_folder(app: AppHandle, folder: AppFolder) -> Result<(), String> {
    let path = match folder {
        AppFolder::Logs => app.state::<Diagnostics>().log_dir.clone(),
        AppFolder::Data => crate::storage::resolve_store_dir_path(&app)?,
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    // Reveal a child to enter the directory even when Finder treats its `.app` name as a bundle.
    if cfg!(target_os = "macos") {
        let item = fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .next()
            .transpose()
            .map_err(|e| e.to_string())?
            .map(|entry| entry.path())
            .unwrap_or(path);
        app.opener()
            .reveal_item_in_dir(item)
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn timestamp(now: time::OffsetDateTime) -> String {
    const FORMAT: &[time::format_description::FormatItem<'_>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    now.format(FORMAT).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_fixed_width_utc() {
        let at = |ms: i128| {
            timestamp(time::OffsetDateTime::from_unix_timestamp_nanos(ms * 1_000_000).unwrap())
        };
        assert_eq!(at(1_793_243_565_000), "2026-10-29T03:12:45.000Z");
        assert_eq!(at(1_793_243_565_007), "2026-10-29T03:12:45.007Z");
    }

    #[test]
    fn levels_reject_unsupported_values() {
        for level in ["warn", "info", "debug"] {
            assert!(config_level(&json!({"logLevel": level})).is_ok());
        }
        for level in [json!("trace"), json!(null), json!(12)] {
            assert!(config_level(&json!({"logLevel": level})).is_err());
        }
    }

    #[test]
    fn all_level_transitions_are_idempotent_and_advance_generation_once() {
        for initial in [LogLevel::Warn, LogLevel::Info, LogLevel::Debug] {
            for next in [LogLevel::Warn, LogLevel::Info, LogLevel::Debug] {
                let mut state = LogLevelState {
                    level: initial,
                    generation: 10,
                };
                assert_eq!(state.update(next), initial != next);
                assert_eq!(state.level, next);
                assert_eq!(state.generation, if initial == next { 10 } else { 11 });
                let generation = state.generation;
                assert!(!state.update(next));
                assert_eq!(state.generation, generation);
            }
        }
    }

    #[test]
    fn identifiers_are_redacted_consistently() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let output = redact(&format!("{id} {id} AA:BB:CC:DD:EE:FF"));
        assert!(!output.contains(id));
        assert!(!output.contains("AA:BB:CC:DD:EE:FF"));
        assert_eq!(
            output.split_whitespace().next(),
            output.split_whitespace().nth(1)
        );
        let legacy =
            redact("device_id=old-device name=\"Old Keyboard\" displayName: \"Custom Label\"");
        for secret in ["old-device", "Old Keyboard", "Custom Label"] {
            assert!(!legacy.contains(secret));
        }
        assert!(!redact("\u{1b}[31merror\u{1b}[0m").contains('\u{1b}'));
    }

    #[test]
    fn known_names_ids_and_home_paths_are_replaced() {
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let device = serde_json::from_value(json!({
            "id": id, "name": "Example Test Keyboard 🔋", "displayName": "Desk Keyboard",
            "batteryInfos": [], "isDisconnected": false, "isCollapsed": false
        }))
        .unwrap();
        update_identities(&[device]);
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap();
        let saved = redact(&format!(
            "{id} Example Test Keyboard 🔋 Desk Keyboard {home}/file.log"
        ));
        for secret in [id, "Example Test Keyboard 🔋", "Desk Keyboard", &home] {
            assert!(!saved.contains(secret));
        }
        assert_eq!(saved.matches(&device_ref(id)).count(), 3);
        assert!(saved.contains("<home>/file.log"));
    }
}
