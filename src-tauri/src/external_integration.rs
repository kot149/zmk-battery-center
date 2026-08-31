use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const EXTERNAL_DIR_NAME: &str = "external";
const BATTERY_STATE_FILENAME: &str = "battery-state-v1.json";

#[cfg(debug_assertions)]
const DATA_DIR_ENV: &str = "ZMK_BATTERY_CENTER_DATA_DIR";
#[cfg(debug_assertions)]
const DEV_DATA_DIR: &str = ".dev-data";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBatteryPartPayload {
    pub id: String,
    pub source_description: Option<String>,
    pub display_name: String,
    pub level_percent: Option<u8>,
    pub observed_at_unix_ms: Option<u64>,
    pub value_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBatteryDevicePayload {
    pub id: String,
    pub key: String,
    pub name: String,
    pub display_name: String,
    pub connection_status: String,
    pub connection_observed_at_unix_ms: Option<u64>,
    pub battery_parts: Vec<ExternalBatteryPartPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatterySnapshot {
    schema_version: u8,
    revision: u64,
    generated_at_unix_ms: u64,
    devices: Vec<ExternalBatteryDevicePayload>,
}

#[derive(Clone, Default)]
struct ExternalIntegrationInner {
    current_source_generation: u64,
    current_source_revision: u64,
    next_source_generation: u64,
    public_revision: u64,
}

#[derive(Clone, Default)]
pub struct ExternalIntegrationState {
    inner: Arc<Mutex<ExternalIntegrationInner>>,
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(debug_assertions)]
fn resolve_debug_external_dir(
    manifest_dir: Option<&str>,
    env_dir: Option<&str>,
) -> Option<PathBuf> {
    let manifest_dir = manifest_dir?;
    let manifest_path = PathBuf::from(manifest_dir);
    let project_root = manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest_path.clone());
    let base = match env_dir {
        Some(dir) => {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                path
            } else {
                project_root.join(path)
            }
        }
        None => project_root.join(DEV_DATA_DIR),
    };
    Some(base.join(EXTERNAL_DIR_NAME))
}

pub fn resolve_external_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok();
        let env_dir = std::env::var(DATA_DIR_ENV).ok();
        if let Some(path) = resolve_debug_external_dir(manifest_dir.as_deref(), env_dir.as_deref())
        {
            return Ok(path);
        }
    }

    app.path()
        .app_data_dir()
        .map(|path| path.join(EXTERNAL_DIR_NAME))
        .map_err(|error| error.to_string())
}

fn ensure_external_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Target path has no parent".to_string())?;
    ensure_external_dir(parent)?;
    let filename = path
        .file_name()
        .ok_or_else(|| "Target path has no filename".to_string())?
        .to_string_lossy();
    let temp_path = parent.join(format!(".{filename}.tmp"));
    let _ = fs::remove_file(&temp_path);

    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        serde_json::to_writer_pretty(&mut file, value).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let rename_result = (0..3).find_map(|attempt| match fs::rename(&temp_path, path) {
        Ok(()) => Some(Ok(())),
        Err(_error) if attempt < 2 => {
            std::thread::sleep(Duration::from_millis(if attempt == 0 { 20 } else { 50 }));
            None
        }
        Err(error) => Some(Err(error.to_string())),
    });

    match rename_result {
        Some(Ok(())) => Ok(()),
        Some(Err(error)) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
        None => {
            let _ = fs::remove_file(&temp_path);
            Err("Atomic rename failed".to_string())
        }
    }
}

fn is_stale_source_publish(
    inner: &ExternalIntegrationInner,
    source_generation: u64,
    source_revision: u64,
) -> bool {
    source_generation != inner.current_source_generation
        || source_revision < inner.current_source_revision
}

#[tauri::command]
pub async fn start_external_battery_source_session(
    state: State<'_, ExternalIntegrationState>,
) -> Result<u64, String> {
    let mut inner = state.inner.lock().await;
    inner.next_source_generation = inner.next_source_generation.saturating_add(1);
    inner.current_source_generation = inner.next_source_generation;
    inner.current_source_revision = 0;
    Ok(inner.current_source_generation)
}

#[tauri::command]
pub async fn publish_external_battery_snapshot(
    app: AppHandle,
    state: State<'_, ExternalIntegrationState>,
    source_generation: u64,
    source_revision: u64,
    devices: Vec<ExternalBatteryDevicePayload>,
) -> Result<(), String> {
    let external_dir = resolve_external_dir(&app)?;
    let mut inner = state.inner.lock().await;
    if is_stale_source_publish(&inner, source_generation, source_revision) {
        return Ok(());
    }

    inner.public_revision = inner.public_revision.saturating_add(1);
    let snapshot = BatterySnapshot {
        schema_version: 1,
        revision: inner.public_revision,
        generated_at_unix_ms: unix_now_ms(),
        devices,
    };
    write_json_atomically(&external_dir.join(BATTERY_STATE_FILENAME), &snapshot)?;
    inner.current_source_revision = source_revision;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn stable_debug_path_uses_external_subdirectory() {
        let path =
            resolve_debug_external_dir(Some("/repo/src-tauri"), Some("custom-data")).expect("path");
        assert_eq!(path, PathBuf::from("/repo/custom-data/external"));
    }

    #[test]
    fn stable_debug_path_uses_default_directory() {
        let path = resolve_debug_external_dir(Some("/repo/src-tauri"), None).expect("path");
        assert_eq!(path, PathBuf::from("/repo/.dev-data/external"));
    }

    #[test]
    fn newer_source_generation_accepts_a_reset_revision() {
        let mut inner = ExternalIntegrationInner {
            current_source_generation: 1,
            current_source_revision: 100,
            next_source_generation: 1,
            public_revision: 0,
        };

        assert!(is_stale_source_publish(&inner, 1, 99));
        assert!(!is_stale_source_publish(&inner, 1, 100));

        inner.current_source_generation = 2;
        inner.current_source_revision = 0;
        assert!(is_stale_source_publish(&inner, 1, 101));
        assert!(!is_stale_source_publish(&inner, 2, 1));
    }

    #[test]
    fn atomic_writer_creates_and_overwrites_strict_json() {
        let dir = tempdir().expect("create temp dir");
        let path = dir.path().join(BATTERY_STATE_FILENAME);
        write_json_atomically(&path, &serde_json::json!({ "unicode": "キーボード" }))
            .expect("write");
        assert_eq!(
            fs::read_to_string(&path).expect("read"),
            "{\n  \"unicode\": \"キーボード\"\n}\n"
        );
        write_json_atomically(&path, &serde_json::json!({ "revision": 2 })).expect("overwrite");
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("strict JSON");
        assert_eq!(parsed["revision"], 2);
        assert!(!dir
            .path()
            .join(format!(".{BATTERY_STATE_FILENAME}.tmp"))
            .exists());
    }
}
