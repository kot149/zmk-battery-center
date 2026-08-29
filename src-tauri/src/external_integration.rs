use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

const EXTERNAL_DIR_NAME: &str = "external";
const BATTERY_STATE_FILENAME: &str = "battery-state-v1.json";
const RUNCAT_FILENAME: &str = "runcat-custom-metrics-v1.json";
const REFRESH_REQUEST_FILENAME: &str = "refresh-request-v1.json";
const REQUEST_MAX_BYTES: usize = 16 * 1024;
const REQUEST_POLL_INTERVAL_MS: u64 = 500;
const REFRESH_COOLDOWN_MS: u64 = 5_000;
const REFRESH_WATCHDOG_MS: u64 = 90_000;
const RECENT_REQUEST_LIMIT: usize = 128;
const REFRESH_REQUESTED_EVENT: &str = "external-battery-refresh-requested";

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
pub struct RunCatMetricPayload {
    pub title: String,
    pub formatted_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCatProjectionPayload {
    pub title: String,
    pub symbol: String,
    pub metrics_bar_value: String,
    pub metrics: Vec<RunCatMetricPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryRefreshDeviceResult {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequestV1 {
    pub schema_version: u8,
    pub request_id: String,
    pub requested_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastRefresh {
    request_id: String,
    requested_at_unix_ms: u64,
    accepted_at_unix_ms: u64,
    completed_at_unix_ms: Option<u64>,
    status: String,
    devices: Vec<BatteryRefreshDeviceResult>,
}

#[derive(Debug, Clone)]
struct ActiveRefresh {
    request: RefreshRequestV1,
    accepted_at_unix_ms: u64,
    deadline_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatterySnapshot {
    schema_version: u8,
    revision: u64,
    generated_at_unix_ms: u64,
    devices: Vec<ExternalBatteryDevicePayload>,
    last_refresh: Option<LastRefresh>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunCatProjectionOutput {
    title: String,
    symbol: String,
    metrics_bar_value: String,
    last_updated_date: String,
    metrics: Vec<RunCatMetricPayload>,
}

#[derive(Clone, Default)]
struct ExternalIntegrationInner {
    current_source_revision: u64,
    current_devices: Vec<ExternalBatteryDevicePayload>,
    current_run_cat_projection: Option<RunCatProjectionPayload>,
    public_revision: u64,
    last_refresh: Option<LastRefresh>,
    active_refresh: Option<ActiveRefresh>,
    recent_accepted_request_ids: VecDeque<String>,
    recent_accepted_request_id_set: HashSet<String>,
    last_external_refresh_accepted_at: Option<u64>,
    last_malformed_fingerprint: Option<u64>,
}

#[derive(Clone, Default)]
pub struct ExternalIntegrationState {
    inner: Arc<Mutex<ExternalIntegrationInner>>,
}

impl ExternalIntegrationState {
    pub async fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        let external_dir = resolve_external_dir(app)?;
        let path = external_dir.join(BATTERY_STATE_FILENAME);
        let contents = match fs::read(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let snapshot: BatterySnapshot =
            serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
        if snapshot.schema_version != 1 {
            return Ok(());
        }

        let mut inner = self.inner.lock().await;
        inner.last_refresh = snapshot.last_refresh.clone();
        if let Some(last_refresh) = snapshot.last_refresh {
            if is_terminal_status(&last_refresh.status) {
                remember_request_id(&mut inner, last_refresh.request_id);
            }
        }
        Ok(())
    }
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "partial" | "failed")
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

fn civil_date_from_days(mut days_since_epoch: i64) -> (i64, u32, u32) {
    days_since_epoch += 719_468;
    let era = if days_since_epoch >= 0 {
        days_since_epoch
    } else {
        days_since_epoch - 146_096
    } / 146_097;
    let doe = (days_since_epoch - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn unix_ms_to_rfc3339(unix_ms: u64) -> String {
    let seconds = unix_ms / 1_000;
    let millis = unix_ms % 1_000;
    let days = (seconds / 86_400) as i64;
    let seconds_today = seconds % 86_400;
    let hours = seconds_today / 3_600;
    let minutes = (seconds_today % 3_600) / 60;
    let seconds = seconds_today % 60;
    let (year, month, day) = civil_date_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

fn remember_request_id(inner: &mut ExternalIntegrationInner, request_id: String) {
    if inner
        .recent_accepted_request_id_set
        .insert(request_id.clone())
    {
        inner.recent_accepted_request_ids.push_back(request_id);
    }
    while inner.recent_accepted_request_ids.len() > RECENT_REQUEST_LIMIT {
        if let Some(oldest) = inner.recent_accepted_request_ids.pop_front() {
            inner.recent_accepted_request_id_set.remove(&oldest);
        }
    }
}

fn empty_run_cat_projection() -> RunCatProjectionPayload {
    RunCatProjectionPayload {
        title: "ZMK Battery Center".to_string(),
        symbol: "battery.100percent".to_string(),
        metrics_bar_value: "N/A".to_string(),
        metrics: vec![],
    }
}

fn run_cat_output(
    projection: &RunCatProjectionPayload,
    generated_at_unix_ms: u64,
) -> RunCatProjectionOutput {
    RunCatProjectionOutput {
        title: projection.title.clone(),
        symbol: projection.symbol.clone(),
        metrics_bar_value: projection.metrics_bar_value.clone(),
        last_updated_date: unix_ms_to_rfc3339(generated_at_unix_ms),
        metrics: projection.metrics.clone(),
    }
}

fn publish_outputs(
    inner: &mut ExternalIntegrationInner,
    external_dir: &Path,
) -> Result<(), String> {
    ensure_external_dir(external_dir)?;
    inner.public_revision = inner.public_revision.saturating_add(1);
    let generated_at_unix_ms = unix_now_ms();
    let snapshot = BatterySnapshot {
        schema_version: 1,
        revision: inner.public_revision,
        generated_at_unix_ms,
        devices: inner.current_devices.clone(),
        last_refresh: inner.last_refresh.clone(),
    };
    let projection = inner
        .current_run_cat_projection
        .clone()
        .unwrap_or_else(empty_run_cat_projection);
    let run_cat = run_cat_output(&projection, generated_at_unix_ms);
    write_json_atomically(&external_dir.join(RUNCAT_FILENAME), &run_cat)?;
    write_json_atomically(&external_dir.join(BATTERY_STATE_FILENAME), &snapshot)
}

fn publish_candidate(
    inner: &mut ExternalIntegrationInner,
    mut candidate: ExternalIntegrationInner,
    external_dir: &Path,
) -> Result<(), String> {
    match publish_outputs(&mut candidate, external_dir) {
        Ok(()) => {
            *inner = candidate;
            Ok(())
        }
        Err(error) => {
            inner.public_revision = inner.public_revision.max(candidate.public_revision);
            inner.current_source_revision = inner
                .current_source_revision
                .max(candidate.current_source_revision);
            Err(error)
        }
    }
}

fn refresh_status(results: &[BatteryRefreshDeviceResult]) -> String {
    if results.is_empty() || results.iter().all(|result| result.status == "updated") {
        "completed".to_string()
    } else if results.iter().all(|result| result.status == "unavailable") {
        "failed".to_string()
    } else {
        "partial".to_string()
    }
}

#[tauri::command]
pub async fn publish_external_battery_snapshot(
    app: AppHandle,
    state: State<'_, ExternalIntegrationState>,
    source_revision: u64,
    devices: Vec<ExternalBatteryDevicePayload>,
    run_cat_projection: RunCatProjectionPayload,
) -> Result<(), String> {
    let external_dir = resolve_external_dir(&app)?;
    let mut inner = state.inner.lock().await;
    if source_revision < inner.current_source_revision {
        return Ok(());
    }
    let mut candidate = inner.clone();
    candidate.current_source_revision = source_revision;
    candidate.current_devices = devices;
    candidate.current_run_cat_projection = Some(run_cat_projection);
    publish_candidate(&mut inner, candidate, &external_dir)
}

#[tauri::command]
pub async fn get_pending_external_battery_refresh(
    state: State<'_, ExternalIntegrationState>,
) -> Result<Option<RefreshRequestV1>, String> {
    let inner = state.inner.lock().await;
    Ok(inner
        .active_refresh
        .as_ref()
        .map(|active| active.request.clone()))
}

#[tauri::command]
pub async fn complete_external_battery_refresh(
    app: AppHandle,
    state: State<'_, ExternalIntegrationState>,
    request_id: String,
    source_revision: u64,
    device_results: Vec<BatteryRefreshDeviceResult>,
    devices: Vec<ExternalBatteryDevicePayload>,
    run_cat_projection: RunCatProjectionPayload,
) -> Result<(), String> {
    let external_dir = resolve_external_dir(&app)?;
    let mut inner = state.inner.lock().await;
    let active = match inner.active_refresh.clone() {
        Some(active) if active.request.request_id == request_id => active,
        _ => return Ok(()),
    };

    let mut candidate = inner.clone();
    if source_revision >= candidate.current_source_revision {
        candidate.current_source_revision = source_revision;
        candidate.current_devices = devices;
        candidate.current_run_cat_projection = Some(run_cat_projection);
    }
    candidate.last_refresh = Some(LastRefresh {
        request_id,
        requested_at_unix_ms: active.request.requested_at_unix_ms,
        accepted_at_unix_ms: active.accepted_at_unix_ms,
        completed_at_unix_ms: Some(unix_now_ms()),
        status: refresh_status(&device_results),
        devices: device_results,
    });
    candidate.active_refresh = None;
    publish_candidate(&mut inner, candidate, &external_dir)
}

fn request_fingerprint(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn read_refresh_request(path: &Path) -> Result<Option<RefreshRequestV1>, (u64, String)> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err((0, error.to_string())),
    };
    let mut bytes = Vec::with_capacity(REQUEST_MAX_BYTES + 1);
    std::io::Read::by_ref(&mut file)
        .take((REQUEST_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| (request_fingerprint(&bytes), error.to_string()))?;
    let fingerprint = request_fingerprint(&bytes);
    if bytes.len() > REQUEST_MAX_BYTES {
        return Err((fingerprint, "request exceeds 16 KiB".to_string()));
    }
    let request: RefreshRequestV1 = serde_json::from_slice(&bytes)
        .map_err(|error| (fingerprint, format!("invalid JSON: {error}")))?;
    if request.schema_version != 1 {
        return Err((fingerprint, "unsupported schemaVersion".to_string()));
    }
    let request_id_bytes = request.request_id.as_bytes();
    if request_id_bytes.is_empty()
        || request_id_bytes.len() > 128
        || request_id_bytes
            .iter()
            .any(|byte| !(0x21..=0x7e).contains(byte))
    {
        return Err((
            fingerprint,
            "requestId must be 1..128 ASCII printable bytes".to_string(),
        ));
    }
    Ok(Some(request))
}

async fn process_refresh_request_tick(app: &AppHandle, state: &ExternalIntegrationState) {
    let external_dir = match resolve_external_dir(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("External integration path unavailable: {error}");
            return;
        }
    };
    let now = unix_now_ms();

    {
        let mut inner = state.inner.lock().await;
        if let Some(active) = inner.active_refresh.clone() {
            if now >= active.deadline_unix_ms {
                let device_results = inner
                    .current_devices
                    .iter()
                    .map(|device| BatteryRefreshDeviceResult {
                        id: device.id.clone(),
                        status: "unavailable".to_string(),
                    })
                    .collect::<Vec<_>>();
                let request = active.request;
                let mut candidate = inner.clone();
                candidate.last_refresh = Some(LastRefresh {
                    request_id: request.request_id,
                    requested_at_unix_ms: request.requested_at_unix_ms,
                    accepted_at_unix_ms: active.accepted_at_unix_ms,
                    completed_at_unix_ms: Some(now),
                    status: "failed".to_string(),
                    devices: device_results,
                });
                candidate.active_refresh = None;
                if let Err(error) = publish_candidate(&mut inner, candidate, &external_dir) {
                    log::warn!("Failed to publish external refresh watchdog result: {error}");
                }
            }
            return;
        }
    }

    let request_path = external_dir.join(REFRESH_REQUEST_FILENAME);
    let request = match read_refresh_request(&request_path) {
        Ok(request) => request,
        Err((fingerprint, error)) => {
            let mut inner = state.inner.lock().await;
            if inner.last_malformed_fingerprint != Some(fingerprint) {
                inner.last_malformed_fingerprint = Some(fingerprint);
                log::warn!("Ignoring malformed external battery refresh request: {error}");
            }
            return;
        }
    };
    let Some(request) = request else { return };

    let mut inner = state.inner.lock().await;
    if inner.active_refresh.is_some() {
        return;
    }
    if inner
        .recent_accepted_request_id_set
        .contains(&request.request_id)
    {
        return;
    }
    if inner
        .last_external_refresh_accepted_at
        .is_some_and(|accepted_at| now < accepted_at.saturating_add(REFRESH_COOLDOWN_MS))
    {
        return;
    }

    let mut candidate = inner.clone();
    candidate.last_malformed_fingerprint = None;
    remember_request_id(&mut candidate, request.request_id.clone());
    candidate.last_external_refresh_accepted_at = Some(now);
    candidate.active_refresh = Some(ActiveRefresh {
        request: request.clone(),
        accepted_at_unix_ms: now,
        deadline_unix_ms: now.saturating_add(REFRESH_WATCHDOG_MS),
    });
    candidate.last_refresh = Some(LastRefresh {
        request_id: request.request_id.clone(),
        requested_at_unix_ms: request.requested_at_unix_ms,
        accepted_at_unix_ms: now,
        completed_at_unix_ms: None,
        status: "pending".to_string(),
        devices: vec![],
    });
    if let Err(error) = publish_candidate(&mut inner, candidate, &external_dir) {
        log::warn!("Failed to publish pending external battery refresh: {error}");
        return;
    }
    drop(inner);

    if let Err(error) = app.emit(REFRESH_REQUESTED_EVENT, request) {
        log::warn!("Failed to emit external battery refresh request: {error}");
    }
}

pub async fn start_refresh_request_monitor(app: AppHandle, state: ExternalIntegrationState) {
    loop {
        process_refresh_request_tick(&app, &state).await;
        sleep(Duration::from_millis(REQUEST_POLL_INTERVAL_MS)).await;
    }
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

    #[test]
    fn failed_candidate_keeps_pending_state_and_does_not_reuse_revision() {
        let dir = tempdir().expect("create temp dir");
        let request = RefreshRequestV1 {
            schema_version: 1,
            request_id: "client-1".to_string(),
            requested_at_unix_ms: 10,
        };
        let mut inner = ExternalIntegrationInner::default();
        inner.active_refresh = Some(ActiveRefresh {
            request: request.clone(),
            accepted_at_unix_ms: 20,
            deadline_unix_ms: 90_020,
        });
        inner.last_refresh = Some(LastRefresh {
            request_id: request.request_id.clone(),
            requested_at_unix_ms: request.requested_at_unix_ms,
            accepted_at_unix_ms: 20,
            completed_at_unix_ms: None,
            status: "pending".to_string(),
            devices: vec![],
        });
        let baseline = inner.clone();
        publish_candidate(&mut inner, baseline, dir.path()).expect("publish pending baseline");
        fs::remove_file(dir.path().join(RUNCAT_FILENAME)).expect("remove RunCat target");
        fs::create_dir(dir.path().join(RUNCAT_FILENAME)).expect("block RunCat target");

        let mut terminal_candidate = inner.clone();
        terminal_candidate.last_refresh.as_mut().unwrap().status = "completed".to_string();
        terminal_candidate
            .last_refresh
            .as_mut()
            .unwrap()
            .completed_at_unix_ms = Some(30);
        terminal_candidate.active_refresh = None;
        assert!(publish_candidate(&mut inner, terminal_candidate, dir.path()).is_err());
        assert!(inner.active_refresh.is_some());
        assert_eq!(inner.last_refresh.as_ref().unwrap().status, "pending");
        assert_eq!(inner.public_revision, 2);
        let pending_snapshot: BatterySnapshot = serde_json::from_str(
            &fs::read_to_string(dir.path().join(BATTERY_STATE_FILENAME))
                .expect("read pending snapshot"),
        )
        .expect("parse pending snapshot");
        assert_eq!(pending_snapshot.revision, 1);
        assert_eq!(pending_snapshot.last_refresh.unwrap().status, "pending");

        fs::remove_dir(dir.path().join(RUNCAT_FILENAME)).expect("remove target blocker");
        let mut retry_candidate = inner.clone();
        retry_candidate.last_refresh.as_mut().unwrap().status = "completed".to_string();
        retry_candidate
            .last_refresh
            .as_mut()
            .unwrap()
            .completed_at_unix_ms = Some(40);
        retry_candidate.active_refresh = None;
        publish_candidate(&mut inner, retry_candidate, dir.path()).expect("retry publish");

        let snapshot: BatterySnapshot = serde_json::from_str(
            &fs::read_to_string(dir.path().join(BATTERY_STATE_FILENAME)).expect("read snapshot"),
        )
        .expect("parse snapshot");
        assert_eq!(snapshot.revision, 3);
        assert_eq!(snapshot.last_refresh.unwrap().status, "completed");
    }

    #[test]
    fn known_epoch_formats_as_rfc3339_utc() {
        assert_eq!(unix_ms_to_rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            unix_ms_to_rfc3339(1_786_060_800_000),
            "2026-08-07T00:00:00.000Z"
        );
    }

    #[test]
    fn request_validation_accepts_unknown_fields_and_rejects_bad_ids() {
        let dir = tempdir().expect("create temp dir");
        let path = dir.path().join(REFRESH_REQUEST_FILENAME);
        fs::write(
            &path,
            br#"{"schemaVersion":1,"requestId":"client-1","requestedAtUnixMs":10,"extra":true}"#,
        )
        .expect("write request");
        let request = read_refresh_request(&path)
            .expect("valid request")
            .expect("present");
        assert_eq!(request.request_id, "client-1");

        fs::write(
            &path,
            br#"{"schemaVersion":1,"requestId":"","requestedAtUnixMs":10}"#,
        )
        .expect("write request");
        assert!(read_refresh_request(&path).is_err());
    }

    #[test]
    fn refresh_status_distinguishes_terminal_results() {
        assert_eq!(refresh_status(&[]), "completed");
        assert_eq!(
            refresh_status(&[BatteryRefreshDeviceResult {
                id: "a".into(),
                status: "updated".into()
            }]),
            "completed"
        );
        assert_eq!(
            refresh_status(&[
                BatteryRefreshDeviceResult {
                    id: "a".into(),
                    status: "updated".into()
                },
                BatteryRefreshDeviceResult {
                    id: "b".into(),
                    status: "unavailable".into()
                },
            ]),
            "partial"
        );
        assert_eq!(
            refresh_status(&[BatteryRefreshDeviceResult {
                id: "a".into(),
                status: "unavailable".into()
            }]),
            "failed"
        );
    }
}
