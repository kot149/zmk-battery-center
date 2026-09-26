use crate::{ble, history, storage};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_autostart::ManagerExt as AutoStartManagerExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, oneshot, Notify};

const CONFIG_FILENAME: &str = "config.json";
const CONFIG_KEY: &str = "config";
const DISMISSED_VERSIONS_KEY: &str = "dismissedVersions";
const DEVICES_FILENAME: &str = "devices.json";
const DEVICES_KEY: &str = "devices";
const STATE_EVENT: &str = "monitor-state-changed";
const HISTORY_EVENT: &str = "battery-history-updated";
const DEFAULT_FETCH_INTERVAL_MS: u64 = 60_000;
const LOW_BATTERY_DEFAULT: u8 = 20;
const HIGH_BATTERY_DEFAULT: u8 = 80;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MonitorSnapshot {
    pub revision: u64,
    pub config: Value,
    pub devices: Vec<MonitorDevice>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDevice {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub battery_infos: Vec<MonitorBatteryInfo>,
    pub is_disconnected: bool,
    pub is_collapsed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_status_known: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_observed_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery_part_labels: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct MonitorBatteryInfo {
    pub battery_level: Option<u8>,
    pub user_description: Option<String>,
    pub observed_at_unix_ms: Option<u64>,
    pub last_read_succeeded: bool,
}

#[derive(Clone, Debug, Serialize)]
struct HistoryEvent {
    #[serde(rename = "deviceId")]
    device_id: String,
    records: Vec<HistoryRecord>,
}

#[derive(Clone, Debug, Serialize)]
struct HistoryRecord {
    timestamp: String,
    user_description: String,
    battery_level: i32,
}

#[derive(Debug)]
enum Request {
    UpdateConfig {
        patch: Value,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    IsUpdateDismissed {
        version: String,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    DismissUpdate {
        version: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    AddDevice {
        device: ble::BleDeviceInfo,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    RemoveDevice {
        id: String,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    SetDeviceDisplayName {
        id: String,
        display_name: Option<String>,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    SetPartLabel {
        id: String,
        source_description: Option<String>,
        label: Option<String>,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    SetDeviceCollapsed {
        id: String,
        collapsed: bool,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    ReorderDevices {
        ids: Vec<String>,
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    Reload {
        reply: oneshot::Sender<Result<MonitorSnapshot, String>>,
    },
    BatteryInfo(ble::BatteryInfoNotificationEvent),
    MonitorStatus(ble::BatteryMonitorStatusEvent),
    Poll {
        reply: oneshot::Sender<Result<(), String>>,
    },
    PollBatchResult {
        token: u64,
        results: Vec<(String, Result<Vec<ble::BatteryInfo>, String>)>,
    },
    MonitorStarted {
        token: u64,
        id: String,
        session_id: u64,
        infos: Vec<ble::BatteryInfo>,
    },
    MonitorFailed {
        token: u64,
        id: String,
        error: String,
    },
}

#[derive(Clone)]
struct MonitorService {
    tx: mpsc::Sender<Request>,
    cache: Arc<RwLock<MonitorSnapshot>>,
    wake: Arc<Notify>,
}

static SERVICE: OnceLock<MonitorService> = OnceLock::new();

fn default_config() -> Value {
    json!({
        "theme": "dark",
        "fetchInterval": DEFAULT_FETCH_INTERVAL_MS,
        "autoStart": false,
        "updateCheckEnabled": false,
        "autoCollapseDisconnectedDevices": false,
        "externalBatterySnapshot": false,
        "pushNotification": false,
        "pushNotificationWhen": {
            "low_battery": true,
            "high_battery": true,
            "connected": true,
            "disconnected": true
        },
        "lowBatteryThreshold": LOW_BATTERY_DEFAULT,
        "ignoreZeroPercent": true,
        "highBatteryThreshold": HIGH_BATTERY_DEFAULT,
        "manualWindowPositioning": false,
        "pinWindow": false,
        "windowPosition": {"x": 0, "y": 0},
        "chartRangeMs": 0,
        "chartSmoothingWindowSize": 30 * 60 * 1000_i64,
        "chartCustomRange": Value::Null,
        "trayIconComponents": ["roleLabel", "batteryIcon", "batteryPercent"]
    })
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn merge_object_values(base: &Value, patch: &Value) -> Value {
    let mut merged = object_or_empty(Some(base));
    for (key, value) in object_or_empty(Some(patch)) {
        merged.insert(key, value);
    }
    Value::Object(merged)
}

fn finite_rounded(value: Option<&Value>, fallback: u8, min: u8, max: u8) -> u8 {
    let Some(number) = value.and_then(Value::as_f64) else {
        return fallback;
    };
    if !number.is_finite() {
        return fallback;
    }
    number.round().clamp(f64::from(min), f64::from(max)) as u8
}

fn dismissed_versions(raw: Option<Value>) -> Vec<String> {
    raw.and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn normalize_config(raw: Option<Value>) -> Value {
    let defaults = default_config();
    let raw_object = object_or_empty(raw.as_ref());
    let mut result = object_or_empty(Some(&defaults));
    for (key, value) in raw_object {
        result.insert(key, value);
    }

    if !result.get("updateCheckEnabled").is_some_and(Value::is_boolean) {
        result.insert("updateCheckEnabled".to_string(), json!(false));
    }

    let default_flags = defaults
        .get("pushNotificationWhen")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let raw_flags = result
        .get("pushNotificationWhen")
        .cloned()
        .unwrap_or(Value::Null);
    result.insert(
        "pushNotificationWhen".to_string(),
        merge_object_values(&default_flags, &raw_flags),
    );

    let default_position = defaults
        .get("windowPosition")
        .cloned()
        .unwrap_or_else(|| json!({"x": 0, "y": 0}));
    let raw_position = result.get("windowPosition").cloned().unwrap_or(Value::Null);
    result.insert(
        "windowPosition".to_string(),
        merge_object_values(&default_position, &raw_position),
    );

    let low = finite_rounded(
        result.get("lowBatteryThreshold"),
        LOW_BATTERY_DEFAULT,
        1,
        98,
    );
    let high = finite_rounded(
        result.get("highBatteryThreshold"),
        HIGH_BATTERY_DEFAULT,
        1,
        99,
    );
    if low < high {
        result.insert("lowBatteryThreshold".to_string(), json!(low));
        result.insert("highBatteryThreshold".to_string(), json!(high));
    } else {
        result.insert(
            "lowBatteryThreshold".to_string(),
            json!(LOW_BATTERY_DEFAULT),
        );
        result.insert(
            "highBatteryThreshold".to_string(),
            json!(HIGH_BATTERY_DEFAULT),
        );
    }

    let valid_interval = match result.get("fetchInterval") {
        Some(Value::String(value)) if value == "auto" => true,
        Some(Value::Number(value)) => value.as_u64().is_some(),
        _ => false,
    };
    if !valid_interval {
        result.insert(
            "fetchInterval".to_string(),
            json!(DEFAULT_FETCH_INTERVAL_MS),
        );
    }

    Value::Object(result)
}

fn config_fetch_interval(config: &Value) -> Option<u64> {
    match config.get("fetchInterval") {
        Some(Value::String(value)) if value == "auto" => None,
        Some(Value::Number(value)) => value.as_u64(),
        _ => Some(DEFAULT_FETCH_INTERVAL_MS),
    }
}

fn config_bool(config: &Value, key: &str, default: bool) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn config_threshold(config: &Value, key: &str, default: u8) -> u8 {
    finite_rounded(config.get(key), default, 1, 99)
}

fn sync_autostart(app: &AppHandle, config: &Value) {
    let desired = config_bool(config, "autoStart", false);
    let manager = app.autolaunch();
    match manager.is_enabled() {
        Ok(enabled) if enabled != desired => {
            let result = if desired {
                manager.enable()
            } else {
                manager.disable()
            };
            if let Err(error) = result {
                log::warn!("Failed to update autostart: {error}");
            }
        }
        Err(error) => log::warn!("Failed to read autostart state: {error}"),
        _ => {}
    }
}

fn config_notification_enabled(config: &Value, key: &str) -> bool {
    config
        .get("pushNotificationWhen")
        .and_then(Value::as_object)
        .and_then(|flags| flags.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn unwrap_device_id(value: &str) -> String {
    if value.starts_with("DeviceId(\"") && value.ends_with("\")") && value.len() > 11 {
        value[10..value.len() - 2].to_string()
    } else {
        value.to_string()
    }
}

fn valid_level(value: Option<&Value>) -> Option<u8> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 100)
        .map(|value| value as u8)
}

fn valid_timestamp(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn normalize_battery_infos(value: Option<&Value>) -> Vec<MonitorBatteryInfo> {
    value
        .and_then(Value::as_array)
        .map(|infos| {
            infos
                .iter()
                .filter_map(|raw| {
                    let object = raw.as_object()?;
                    let user_description = object
                        .get("user_description")
                        .or_else(|| object.get("user_descriptor"))
                        .and_then(|value| match value {
                            Value::String(value) => Some(value.clone()),
                            Value::Null => None,
                            _ => None,
                        });
                    Some(MonitorBatteryInfo {
                        battery_level: valid_level(object.get("battery_level")),
                        user_description,
                        observed_at_unix_ms: valid_timestamp(object.get("observed_at_unix_ms")),
                        last_read_succeeded: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn known_device_key(key: &str) -> bool {
    matches!(
        key,
        "id" | "name"
            | "displayName"
            | "batteryInfos"
            | "isDisconnected"
            | "isCollapsed"
            | "connectionStatusKnown"
            | "connectionObservedAtUnixMs"
            | "batteryPartLabels"
    )
}

pub fn normalize_devices(raw: Option<Value>) -> Vec<MonitorDevice> {
    raw.and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|raw| {
            let object = raw.as_object().cloned().unwrap_or_default();
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .map(unwrap_device_id)
                .unwrap_or_default();
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .map(unwrap_device_id)
                .unwrap_or_default();
            let display_name = object
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let battery_part_labels = object
                .get("batteryPartLabels")
                .and_then(Value::as_object)
                .map(|labels| {
                    labels
                        .iter()
                        .filter_map(|(key, value)| {
                            let value = value.as_str()?.trim();
                            (!value.is_empty()).then(|| (key.clone(), value.to_string()))
                        })
                        .collect::<HashMap<String, String>>()
                })
                .filter(|labels| !labels.is_empty());
            let extra = object
                .clone()
                .into_iter()
                .filter(|(key, _)| !known_device_key(key))
                .collect();
            MonitorDevice {
                id,
                name,
                display_name,
                battery_infos: normalize_battery_infos(object.get("batteryInfos")),
                is_disconnected: true,
                is_collapsed: object
                    .get("isCollapsed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                connection_status_known: Some(false),
                connection_observed_at_unix_ms: None,
                battery_part_labels,
                extra,
            }
        })
        .collect()
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn annotate_infos(infos: &[ble::BatteryInfo], observed_at: u64) -> Vec<MonitorBatteryInfo> {
    infos
        .iter()
        .map(|info| match info.battery_level {
            Some(level) if level <= 100 => MonitorBatteryInfo {
                battery_level: Some(level),
                user_description: info.user_description.clone(),
                observed_at_unix_ms: Some(observed_at),
                last_read_succeeded: true,
            },
            _ => MonitorBatteryInfo {
                battery_level: None,
                user_description: info.user_description.clone(),
                observed_at_unix_ms: None,
                last_read_succeeded: false,
            },
        })
        .collect()
}

fn part_key(description: Option<&str>) -> Option<&str> {
    description
}

fn merge_infos(
    previous: &[MonitorBatteryInfo],
    next: &[MonitorBatteryInfo],
) -> Vec<MonitorBatteryInfo> {
    next.iter()
        .map(|info| {
            if info.battery_level.is_some() {
                return info.clone();
            }
            let old = previous.iter().find(|old| {
                part_key(old.user_description.as_deref())
                    == part_key(info.user_description.as_deref())
            });
            old.map(|old| MonitorBatteryInfo {
                battery_level: old.battery_level,
                user_description: info.user_description.clone(),
                observed_at_unix_ms: old.observed_at_unix_ms,
                last_read_succeeded: false,
            })
            .unwrap_or_else(|| info.clone())
        })
        .collect()
}

fn upsert_info(
    previous: &[MonitorBatteryInfo],
    info: MonitorBatteryInfo,
) -> Vec<MonitorBatteryInfo> {
    let key = part_key(info.user_description.as_deref());
    let Some(index) = previous
        .iter()
        .position(|old| part_key(old.user_description.as_deref()) == key)
    else {
        return previous.iter().cloned().chain([info]).collect();
    };
    let mut result = previous.to_vec();
    result[index] = if info.battery_level.is_some() {
        info
    } else {
        MonitorBatteryInfo {
            battery_level: previous[index].battery_level,
            user_description: info.user_description,
            observed_at_unix_ms: previous[index].observed_at_unix_ms,
            last_read_succeeded: false,
        }
    };
    result
}

fn mark_infos_failed(infos: &[MonitorBatteryInfo]) -> Vec<MonitorBatteryInfo> {
    infos
        .iter()
        .cloned()
        .map(|mut info| {
            info.last_read_succeeded = false;
            info
        })
        .collect()
}

fn apply_collapse(device: &mut MonitorDevice, auto_collapse: bool) {
    if auto_collapse && device.is_disconnected {
        device.is_collapsed = true;
    } else if auto_collapse && !device.is_disconnected && device.is_collapsed {
        device.is_collapsed = false;
    }
}

fn display_name(device: &MonitorDevice) -> &str {
    device
        .display_name
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(&device.name)
}

fn default_part_name(description: Option<&str>) -> &str {
    description.unwrap_or("Central")
}

fn part_display_name(device: &MonitorDevice, description: Option<&str>) -> String {
    let key = description.unwrap_or("Central");
    device
        .battery_part_labels
        .as_ref()
        .and_then(|labels| labels.get(key))
        .map(|label| label.trim())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| default_part_name(description))
        .to_string()
}

fn notification_low_state(
    infos: &[MonitorBatteryInfo],
    threshold: u8,
    ignore_zero: bool,
) -> Vec<bool> {
    infos
        .iter()
        .map(|info| {
            info.battery_level
                .map(|level| level <= threshold && (!ignore_zero || level != 0))
                .unwrap_or(false)
        })
        .collect()
}

fn notification_high_state(infos: &[MonitorBatteryInfo], threshold: u8) -> Vec<bool> {
    infos
        .iter()
        .map(|info| {
            info.battery_level
                .map(|level| level >= threshold)
                .unwrap_or(false)
        })
        .collect()
}

fn emit_edge_notifications(
    app: &AppHandle,
    config: &Value,
    device: &MonitorDevice,
    previous: &[MonitorBatteryInfo],
    current: &[MonitorBatteryInfo],
) {
    if !config_bool(config, "pushNotification", false) {
        return;
    }
    let low_threshold = config_threshold(config, "lowBatteryThreshold", LOW_BATTERY_DEFAULT);
    let high_threshold = config_threshold(config, "highBatteryThreshold", HIGH_BATTERY_DEFAULT);
    let ignore_zero = config_bool(config, "ignoreZeroPercent", true);
    let low_previous = notification_low_state(previous, low_threshold, ignore_zero);
    let low_current = notification_low_state(current, low_threshold, ignore_zero);
    let high_previous = notification_high_state(previous, high_threshold);
    let high_current = notification_high_state(current, high_threshold);

    let notify = |enabled_key: &str,
                  previous_state: &[bool],
                  current_state: &[bool],
                  verb: &str,
                  threshold: u8| {
        if !config_notification_enabled(config, enabled_key) {
            return;
        }
        for index in 0..current_state.len().min(previous_state.len()) {
            if previous_state[index] || !current_state[index] {
                continue;
            }
            let part = current.get(index);
            let description = part.and_then(|part| part.user_description.as_deref());
            let label = part.map(|_| part_display_name(device, description));
            let has_custom = label
                .as_deref()
                .map(|label| label != default_part_name(description))
                .unwrap_or(false);
            let suffix = if current.len() >= 2 || has_custom {
                format!(" {}", label.unwrap_or_else(|| "Central".to_string()))
            } else {
                String::new()
            };
            let message = format!(
                "{}{} battery {} {}%.",
                display_name(device),
                suffix,
                verb,
                threshold
            );
            log::info!("{message}");
            if let Err(error) = app.notification().builder().title(message.clone()).show() {
                log::warn!("Failed to send battery notification: {error}");
            }
        }
    };

    notify(
        "low_battery",
        &low_previous,
        &low_current,
        "dropped below",
        low_threshold,
    );
    notify(
        "high_battery",
        &high_previous,
        &high_current,
        "reached",
        high_threshold,
    );
}

fn emit_connection_notification(
    app: &AppHandle,
    config: &Value,
    device: &MonitorDevice,
    connected: bool,
) {
    if !config_bool(config, "pushNotification", false) {
        return;
    }
    let key = if connected {
        "connected"
    } else {
        "disconnected"
    };
    if !config_notification_enabled(config, key) {
        return;
    }
    let message = if connected {
        format!("{} has been connected.", display_name(device))
    } else {
        format!("{} has been disconnected.", display_name(device))
    };
    log::info!("{message}");
    if let Err(error) = app.notification().builder().title(message).show() {
        log::warn!("Failed to send connection notification: {error}");
    }
}

fn history_records(infos: &[MonitorBatteryInfo], timestamp: &str) -> Vec<HistoryRecord> {
    infos
        .iter()
        .filter_map(|info| {
            Some(HistoryRecord {
                timestamp: timestamp.to_string(),
                user_description: info
                    .user_description
                    .clone()
                    .unwrap_or_else(|| "Central".into()),
                battery_level: i32::from(info.battery_level?),
            })
        })
        .collect()
}

fn record_history(app: &AppHandle, device: &MonitorDevice, infos: &[MonitorBatteryInfo]) {
    let Ok(timestamp) = history::current_timestamp_rfc3339() else {
        log::warn!("Failed to obtain history timestamp for {}", device.id);
        return;
    };
    let records = history_records(infos, &timestamp);
    if records.is_empty() {
        return;
    }
    for record in &records {
        if let Err(error) = history::append_battery_history_record(
            app,
            &device.name,
            &device.id,
            &record.timestamp,
            &record.user_description,
            record.battery_level,
        ) {
            log::warn!(
                "Failed to append battery history for {}: {error}",
                device.id
            );
        }
    }
    if crate::window::main_window_requested(app) {
        let _ = app.emit_to(
            "main",
            HISTORY_EVENT,
            HistoryEvent {
                device_id: device.id.clone(),
                records,
            },
        );
    }
}

fn service() -> Result<MonitorService, String> {
    SERVICE
        .get()
        .cloned()
        .ok_or_else(|| "Monitor service is not initialized".to_string())
}

pub fn current_config(_app: &AppHandle) -> Value {
    SERVICE
        .get()
        .and_then(|service| {
            service
                .cache
                .read()
                .ok()
                .map(|snapshot| snapshot.config.clone())
        })
        .unwrap_or_else(default_config)
}

pub fn current_snapshot() -> Option<MonitorSnapshot> {
    SERVICE
        .get()
        .and_then(|service| service.cache.read().ok().map(|snapshot| snapshot.clone()))
}

pub fn on_battery_info_notification(payload: ble::BatteryInfoNotificationEvent) {
    let Some(service) = SERVICE.get() else {
        return;
    };
    if service.tx.try_send(Request::BatteryInfo(payload)).is_err() {
        log::warn!("Dropping battery info event because monitor queue is full");
    }
}

pub fn on_battery_monitor_status(payload: ble::BatteryMonitorStatusEvent) {
    let Some(service) = SERVICE.get() else {
        return;
    };
    if service
        .tx
        .try_send(Request::MonitorStatus(payload))
        .is_err()
    {
        log::warn!("Dropping monitor status event because monitor queue is full");
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }

    let config = normalize_config(storage::load_store_value(app, CONFIG_FILENAME, CONFIG_KEY)?);
    let devices = normalize_devices(storage::load_store_value(
        app,
        DEVICES_FILENAME,
        DEVICES_KEY,
    )?);
    let snapshot = MonitorSnapshot {
        revision: 1,
        config,
        devices,
    };
    let cache = Arc::new(RwLock::new(snapshot.clone()));
    let wake = Arc::new(Notify::new());
    let (tx, rx) = mpsc::channel(256);
    let service = MonitorService {
        tx: tx.clone(),
        cache: cache.clone(),
        wake: wake.clone(),
    };
    SERVICE
        .set(service.clone())
        .map_err(|_| "Monitor service was initialized concurrently".to_string())?;

    let initial_app = app.clone();
    let initial_snapshot = snapshot.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            crate::external_integration::publish_monitor_snapshot(&initial_app, &initial_snapshot)
                .await
        {
            log::warn!("Failed to publish initial external battery snapshot: {error}");
        }
    });

    let actor_app = app.clone();
    tauri::async_runtime::spawn(actor_loop(actor_app, snapshot, cache, tx.clone(), rx, wake));
    tauri::async_runtime::spawn(scheduler_loop(service));
    Ok(())
}

async fn scheduler_loop(service: MonitorService) {
    loop {
        let interval = service
            .cache
            .read()
            .ok()
            .and_then(|snapshot| config_fetch_interval(&snapshot.config));
        match interval {
            Some(milliseconds) => {
                let (reply_tx, reply_rx) = oneshot::channel();
                if service
                    .tx
                    .send(Request::Poll { reply: reply_tx })
                    .await
                    .is_err()
                {
                    return;
                }
                let _ = reply_rx.await;
                let duration = Duration::from_millis(milliseconds.max(1));
                tokio::select! {
                    _ = tokio::time::sleep(duration) => {}
                    _ = service.wake.notified() => {}
                }
            }
            None => {
                service.wake.notified().await;
            }
        }
    }
}

async fn actor_loop(
    app: AppHandle,
    snapshot: MonitorSnapshot,
    cache: Arc<RwLock<MonitorSnapshot>>,
    tx: mpsc::Sender<Request>,
    mut rx: mpsc::Receiver<Request>,
    wake: Arc<Notify>,
) {
    let mut core = MonitorCore {
        app,
        snapshot,
        cache,
        tx,
        active_monitors: HashSet::new(),
        active_monitor_sessions: HashMap::new(),
        monitor_token: 0,
        poll_token: 0,
        poll_in_flight: false,
        wake,
    };
    core.schedule_reconfigure();

    while let Some(request) = rx.recv().await {
        match request {
            Request::UpdateConfig { patch, reply } => {
                let result = core.update_config(patch);
                let _ = reply.send(result);
            }
            Request::IsUpdateDismissed { version, reply } => {
                let result = core.is_update_dismissed(&version);
                let _ = reply.send(result);
            }
            Request::DismissUpdate { version, reply } => {
                let result = core.dismiss_update(&version);
                let _ = reply.send(result);
            }
            Request::AddDevice { device, reply } => {
                let result = core.add_device(device);
                let _ = reply.send(result);
            }
            Request::RemoveDevice { id, reply } => {
                let result = core.remove_device(&id);
                let _ = reply.send(result);
            }
            Request::SetDeviceDisplayName {
                id,
                display_name,
                reply,
            } => {
                let result = core.set_device_display_name(&id, display_name);
                let _ = reply.send(result);
            }
            Request::SetPartLabel {
                id,
                source_description,
                label,
                reply,
            } => {
                let result = core.set_part_label(&id, source_description.as_deref(), label);
                let _ = reply.send(result);
            }
            Request::SetDeviceCollapsed {
                id,
                collapsed,
                reply,
            } => {
                let result = core.set_device_collapsed(&id, collapsed);
                let _ = reply.send(result);
            }
            Request::ReorderDevices { ids, reply } => {
                let result = core.reorder_devices(ids);
                let _ = reply.send(result);
            }
            Request::Reload { reply } => {
                let result = core.reload();
                let _ = reply.send(result);
            }
            Request::BatteryInfo(payload) => {
                if let Err(error) = core.handle_battery_info(payload) {
                    log::warn!("Failed to process battery info notification: {error}");
                }
            }
            Request::MonitorStatus(payload) => {
                if let Err(error) = core.handle_monitor_status(payload) {
                    log::warn!("Failed to process battery monitor status: {error}");
                }
            }
            Request::Poll { reply } => {
                core.schedule_poll();
                let _ = reply.send(Ok(()));
            }
            Request::PollBatchResult { token, results } => {
                core.handle_poll_batch_result(token, results);
            }
            Request::MonitorStarted {
                token,
                id,
                session_id,
                infos,
            } => {
                core.handle_monitor_started(token, &id, session_id, &infos);
            }
            Request::MonitorFailed { token, id, error } => {
                core.handle_monitor_failed(token, &id, &error);
            }
        }
    }

    let _ = core.stop_all_monitors().await;
}

struct MonitorCore {
    app: AppHandle,
    snapshot: MonitorSnapshot,
    cache: Arc<RwLock<MonitorSnapshot>>,
    tx: mpsc::Sender<Request>,
    active_monitors: HashSet<String>,
    active_monitor_sessions: HashMap<String, u64>,
    monitor_token: u64,
    poll_token: u64,
    poll_in_flight: bool,
    wake: Arc<Notify>,
}

fn is_current_monitor_session(
    active_sessions: &HashMap<String, u64>,
    device_id: &str,
    session_id: u64,
) -> bool {
    active_sessions.get(device_id).copied() == Some(session_id)
}

impl MonitorCore {
    fn is_update_dismissed(&self, version: &str) -> Result<bool, String> {
        let saved = storage::load_store_value(&self.app, CONFIG_FILENAME, DISMISSED_VERSIONS_KEY)?;
        Ok(dismissed_versions(saved)
            .iter()
            .any(|saved| saved == version))
    }

    fn dismiss_update(&self, version: &str) -> Result<(), String> {
        let saved = storage::load_store_value(&self.app, CONFIG_FILENAME, DISMISSED_VERSIONS_KEY)?;
        let mut versions = dismissed_versions(saved);
        if versions.iter().any(|saved| saved == version) {
            return Ok(());
        }
        versions.push(version.to_string());
        storage::save_store_value(
            &self.app,
            CONFIG_FILENAME,
            DISMISSED_VERSIONS_KEY,
            json!(versions),
        )
    }

    fn publish(&mut self, save_config: bool, save_devices: bool) -> Result<(), String> {
        let previous = self.snapshot.clone();
        if save_config {
            if let Err(error) = storage::save_store_value(
                &self.app,
                CONFIG_FILENAME,
                CONFIG_KEY,
                self.snapshot.config.clone(),
            ) {
                self.snapshot = previous;
                return Err(error);
            }
        }
        if save_devices {
            let value = serde_json::to_value(&self.snapshot.devices).map_err(|error| {
                self.snapshot = previous.clone();
                error.to_string()
            })?;
            if let Err(error) =
                storage::save_store_value(&self.app, DEVICES_FILENAME, DEVICES_KEY, value)
            {
                if save_config {
                    let _ = storage::save_store_value(
                        &self.app,
                        CONFIG_FILENAME,
                        CONFIG_KEY,
                        previous.config.clone(),
                    );
                }
                let _ = storage::save_store_value(
                    &self.app,
                    DEVICES_FILENAME,
                    DEVICES_KEY,
                    serde_json::to_value(&previous.devices).unwrap_or(Value::Null),
                );
                self.snapshot = previous;
                return Err(error);
            }
        }
        self.snapshot.revision = self.snapshot.revision.saturating_add(1);
        if let Ok(mut cache) = self.cache.write() {
            *cache = self.snapshot.clone();
        }
        if crate::window::main_window_requested(&self.app) {
            let _ = self.app.emit_to("main", STATE_EVENT, &self.snapshot);
        }
        let app = self.app.clone();
        let snapshot = self.snapshot.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                crate::external_integration::publish_monitor_snapshot(&app, &snapshot).await
            {
                log::warn!("Failed to publish external battery snapshot: {error}");
            }
            if let Err(error) = crate::tray_battery_payload::refresh(&app, &snapshot) {
                log::debug!("Failed to refresh tray battery payload: {error}");
            }
        });
        Ok(())
    }

    fn device_index(&self, id: &str) -> Option<usize> {
        self.snapshot
            .devices
            .iter()
            .position(|device| device.id == id)
    }

    fn auto_collapse(&self) -> bool {
        config_bool(
            &self.snapshot.config,
            "autoCollapseDisconnectedDevices",
            false,
        )
    }

    fn update_config(&mut self, patch: Value) -> Result<MonitorSnapshot, String> {
        let previous_mode = config_fetch_interval(&self.snapshot.config);
        let previous_auto_collapse = self.auto_collapse();
        let mut merged = merge_object_values(&self.snapshot.config, &patch);
        if let Some(object) = merged.as_object_mut() {
            for key in ["pushNotificationWhen", "windowPosition"] {
                if let Some(patch_value) = patch.get(key) {
                    let current_value = self.snapshot.config.get(key).unwrap_or(&Value::Null);
                    object.insert(
                        key.to_string(),
                        merge_object_values(current_value, patch_value),
                    );
                }
            }
        }
        self.snapshot.config = normalize_config(Some(merged));
        let next_mode = config_fetch_interval(&self.snapshot.config);
        if self.auto_collapse() && !previous_auto_collapse {
            for device in &mut self.snapshot.devices {
                apply_collapse(device, true);
            }
        }
        self.publish(true, true)?;
        if previous_mode != next_mode {
            self.schedule_reconfigure();
        }
        let config = self.snapshot.config.clone();
        if patch.get("autoStart").is_some() {
            sync_autostart(&self.app, &config);
        }
        crate::tray::sync_config(&self.app, &config);
        self.wake.notify_one();
        Ok(self.snapshot.clone())
    }

    fn add_device(&mut self, device: ble::BleDeviceInfo) -> Result<MonitorSnapshot, String> {
        if self
            .snapshot
            .devices
            .iter()
            .any(|registered| registered.id == device.id)
        {
            return Ok(self.snapshot.clone());
        }
        let disconnected = true;
        let mut registered = MonitorDevice {
            id: device.id.clone(),
            name: device.name,
            display_name: None,
            battery_infos: Vec::new(),
            is_disconnected: disconnected,
            is_collapsed: disconnected && self.auto_collapse(),
            connection_status_known: Some(false),
            connection_observed_at_unix_ms: None,
            battery_part_labels: None,
            extra: Map::new(),
        };
        apply_collapse(&mut registered, self.auto_collapse());
        self.snapshot.devices.push(registered);
        self.publish(false, true)?;
        if config_fetch_interval(&self.snapshot.config).is_none() {
            self.schedule_reconfigure();
        } else {
            self.schedule_poll();
        }
        Ok(self.snapshot.clone())
    }

    fn remove_device(&mut self, id: &str) -> Result<MonitorSnapshot, String> {
        let Some(index) = self.device_index(id) else {
            return Ok(self.snapshot.clone());
        };
        self.snapshot.devices.remove(index);
        self.publish(false, true)?;
        let was_active = self.active_monitors.remove(id);
        let session_id = self.active_monitor_sessions.remove(id);
        if was_active || session_id.is_some() {
            self.spawn_stop_monitor(id.to_string(), session_id);
        }
        self.schedule_reconfigure();
        Ok(self.snapshot.clone())
    }

    fn set_device_display_name(
        &mut self,
        id: &str,
        display_name_value: Option<String>,
    ) -> Result<MonitorSnapshot, String> {
        let Some(index) = self.device_index(id) else {
            return Err(format!("Device not found: {id}"));
        };
        let default_name = self.snapshot.devices[index].name.clone();
        let display_name_value = trim_optional(display_name_value);
        self.snapshot.devices[index].display_name =
            display_name_value.filter(|display_name| display_name != &default_name);
        self.publish(false, true)?;
        Ok(self.snapshot.clone())
    }

    fn set_part_label(
        &mut self,
        id: &str,
        source_description: Option<&str>,
        label: Option<String>,
    ) -> Result<MonitorSnapshot, String> {
        let Some(index) = self.device_index(id) else {
            return Err(format!("Device not found: {id}"));
        };
        let key = source_description.unwrap_or("Central").to_string();
        let default_name = source_description.unwrap_or("Central");
        let label = trim_optional(label).filter(|label| label != default_name);
        let device = &mut self.snapshot.devices[index];
        let labels = device.battery_part_labels.get_or_insert_with(HashMap::new);
        match label {
            Some(label) => {
                labels.insert(key, label);
            }
            None => {
                labels.remove(&key);
            }
        }
        if labels.is_empty() {
            device.battery_part_labels = None;
        }
        self.publish(false, true)?;
        Ok(self.snapshot.clone())
    }

    fn set_device_collapsed(
        &mut self,
        id: &str,
        collapsed: bool,
    ) -> Result<MonitorSnapshot, String> {
        let Some(index) = self.device_index(id) else {
            return Err(format!("Device not found: {id}"));
        };
        self.snapshot.devices[index].is_collapsed = collapsed;
        self.publish(false, true)?;
        Ok(self.snapshot.clone())
    }

    fn reorder_devices(&mut self, ids: Vec<String>) -> Result<MonitorSnapshot, String> {
        let expected: HashSet<&str> = self
            .snapshot
            .devices
            .iter()
            .map(|device| device.id.as_str())
            .collect();
        let actual: HashSet<&str> = ids.iter().map(String::as_str).collect();
        if ids.len() != expected.len() || actual != expected {
            return Err("Device order must contain every registered device exactly once".into());
        }
        let mut by_id: HashMap<String, MonitorDevice> = self
            .snapshot
            .devices
            .drain(..)
            .map(|device| (device.id.clone(), device))
            .collect();
        self.snapshot.devices = ids.into_iter().filter_map(|id| by_id.remove(&id)).collect();
        self.publish(false, true)?;
        Ok(self.snapshot.clone())
    }

    fn reload(&mut self) -> Result<MonitorSnapshot, String> {
        if config_fetch_interval(&self.snapshot.config).is_none() {
            self.schedule_reconfigure();
        } else {
            self.schedule_poll();
        }
        Ok(self.snapshot.clone())
    }

    fn schedule_reconfigure(&mut self) {
        self.monitor_token = self.monitor_token.saturating_add(1);
        let token = self.monitor_token;
        let desired: Vec<String> = if config_fetch_interval(&self.snapshot.config).is_none() {
            self.snapshot
                .devices
                .iter()
                .map(|device| device.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        let previous_active: Vec<(String, Option<u64>)> = self
            .active_monitors
            .drain()
            .map(|id| {
                let session_id = self.active_monitor_sessions.remove(&id);
                (id, session_id)
            })
            .collect();
        let app = self.app.clone();
        let tx = self.tx.clone();
        tauri::async_runtime::spawn(async move {
            for (id, session_id) in previous_active {
                match session_id {
                    Some(session_id) => {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(10),
                            ble::stop_battery_notification_monitor_if_session(id, session_id),
                        )
                        .await;
                    }
                    None => {
                        let result = tokio::time::timeout(
                            Duration::from_secs(10),
                            ble::stop_battery_notification_monitor(id.clone()),
                        )
                        .await;
                        if let Ok(Err(error)) = result {
                            log::warn!("Failed to stop battery monitor for {id}: {error}");
                        }
                    }
                }
            }
            for id in desired {
                let result = tokio::time::timeout(
                    Duration::from_secs(30),
                    ble::start_battery_notification_monitor_with_session(app.clone(), id.clone()),
                )
                .await;
                match result {
                    Ok(Ok(started)) => {
                        let _ = tx
                            .send(Request::MonitorStarted {
                                token,
                                id,
                                session_id: started.session_id,
                                infos: started.battery_infos,
                            })
                            .await;
                    }
                    Ok(Err(error)) => {
                        let _ = tx.send(Request::MonitorFailed { token, id, error }).await;
                    }
                    Err(_) => {
                        let _ = tx
                            .send(Request::MonitorFailed {
                                token,
                                id,
                                error: "Battery monitor start timed out".to_string(),
                            })
                            .await;
                    }
                }
            }
        });
    }

    fn schedule_poll(&mut self) {
        if config_fetch_interval(&self.snapshot.config).is_none() || self.poll_in_flight {
            return;
        }
        self.poll_in_flight = true;
        self.poll_token = self.poll_token.saturating_add(1);
        let token = self.poll_token;
        let devices = self.snapshot.devices.clone();
        let tx = self.tx.clone();
        tauri::async_runtime::spawn(async move {
            let results = join_all(devices.iter().map(|device| {
                let id = device.id.clone();
                let disconnected = device.is_disconnected;
                async move { (id.clone(), read_poll_with_retries(&id, disconnected).await) }
            }))
            .await;
            let _ = tx.send(Request::PollBatchResult { token, results }).await;
        });
    }

    fn handle_poll_batch_result(
        &mut self,
        token: u64,
        results: Vec<(String, Result<Vec<ble::BatteryInfo>, String>)>,
    ) {
        if token != self.poll_token {
            return;
        }
        self.poll_in_flight = false;
        if config_fetch_interval(&self.snapshot.config).is_none() {
            return;
        }
        let mut changed = false;
        for (id, result) in results {
            changed |= self.apply_poll_result(&id, result);
        }
        if changed {
            if let Err(error) = self.publish(false, true) {
                log::warn!("Failed to publish polling state: {error}");
            }
        }
    }

    fn handle_monitor_started(
        &mut self,
        token: u64,
        id: &str,
        session_id: u64,
        infos: &[ble::BatteryInfo],
    ) {
        if token != self.monitor_token
            || config_fetch_interval(&self.snapshot.config).is_some()
            || self.device_index(id).is_none()
        {
            self.spawn_stop_monitor(id.to_string(), Some(session_id));
            return;
        }
        self.active_monitors.insert(id.to_string());
        self.active_monitor_sessions
            .insert(id.to_string(), session_id);
        if self.apply_initial_infos(id, infos) {
            if let Err(error) = self.publish(false, true) {
                log::warn!("Failed to publish monitor start state: {error}");
            }
        }
    }

    fn handle_monitor_failed(&mut self, token: u64, id: &str, error: &str) {
        if token != self.monitor_token || config_fetch_interval(&self.snapshot.config).is_some() {
            return;
        }
        log::warn!("Failed to start battery monitor for {id}: {error}");
        if self.apply_monitor_failure(id) {
            if let Err(error) = self.publish(false, true) {
                log::warn!("Failed to publish monitor failure state: {error}");
            }
        }
    }

    fn spawn_stop_monitor(&self, id: String, session_id: Option<u64>) {
        tauri::async_runtime::spawn(async move {
            match session_id {
                Some(session_id) => {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        ble::stop_battery_notification_monitor_if_session(id, session_id),
                    )
                    .await;
                }
                None => {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        ble::stop_battery_notification_monitor(id),
                    )
                    .await;
                }
            }
        });
    }

    async fn stop_all_monitors(&mut self) -> Result<(), String> {
        self.active_monitors.clear();
        self.active_monitor_sessions.clear();
        ble::stop_all_battery_monitors().await;
        Ok(())
    }

    fn apply_initial_infos(&mut self, id: &str, infos: &[ble::BatteryInfo]) -> bool {
        let Some(index) = self.device_index(id) else {
            return false;
        };
        let now = unix_now_ms();
        let annotated = annotate_infos(infos, now);
        let auto_collapse = self.auto_collapse();
        let device = &mut self.snapshot.devices[index];
        if annotated.is_empty() {
            device.battery_infos = mark_infos_failed(&device.battery_infos);
            device.is_disconnected = true;
        } else {
            device.battery_infos = merge_infos(&device.battery_infos, &annotated);
            device.is_disconnected = false;
        }
        device.connection_status_known = Some(true);
        device.connection_observed_at_unix_ms = Some(now);
        apply_collapse(device, auto_collapse);
        true
    }

    fn apply_monitor_failure(&mut self, id: &str) -> bool {
        let Some(index) = self.device_index(id) else {
            return false;
        };
        let auto_collapse = self.auto_collapse();
        let device = &mut self.snapshot.devices[index];
        device.battery_infos = mark_infos_failed(&device.battery_infos);
        device.is_disconnected = true;
        device.connection_status_known = Some(true);
        device.connection_observed_at_unix_ms = Some(unix_now_ms());
        apply_collapse(device, auto_collapse);
        true
    }

    fn apply_poll_result(
        &mut self,
        id: &str,
        result: Result<Vec<ble::BatteryInfo>, String>,
    ) -> bool {
        let Some(index) = self.device_index(id) else {
            return false;
        };
        let previous = self.snapshot.devices[index].clone();
        let now = unix_now_ms();
        match result {
            Ok(infos) => {
                let annotated = annotate_infos(&infos, now);
                record_history(&self.app, &previous, &annotated);
                emit_edge_notifications(
                    &self.app,
                    &self.snapshot.config,
                    &previous,
                    &previous.battery_infos,
                    &annotated,
                );
                let mut next = previous.clone();
                next.battery_infos = merge_infos(&previous.battery_infos, &annotated);
                next.is_disconnected = false;
                next.connection_status_known = Some(true);
                next.connection_observed_at_unix_ms = Some(now);
                apply_collapse(&mut next, self.auto_collapse());
                if previous.is_disconnected {
                    emit_connection_notification(&self.app, &self.snapshot.config, &next, true);
                }
                self.snapshot.devices[index] = next;
            }
            Err(error) => {
                log::debug!("Polling failed for {id}: {error}");
                let mut next = previous.clone();
                next.battery_infos = mark_infos_failed(&previous.battery_infos);
                next.is_disconnected = true;
                next.connection_status_known = Some(true);
                next.connection_observed_at_unix_ms = Some(now);
                apply_collapse(&mut next, self.auto_collapse());
                if !previous.is_disconnected {
                    emit_connection_notification(&self.app, &self.snapshot.config, &next, false);
                }
                self.snapshot.devices[index] = next;
            }
        }
        true
    }

    fn handle_battery_info(
        &mut self,
        payload: ble::BatteryInfoNotificationEvent,
    ) -> Result<(), String> {
        if config_fetch_interval(&self.snapshot.config).is_some()
            || !is_current_monitor_session(
                &self.active_monitor_sessions,
                &payload.id,
                payload.session_id,
            )
        {
            return Ok(());
        }
        let Some(index) = self.device_index(&payload.id) else {
            return Ok(());
        };
        let previous = self.snapshot.devices[index].clone();
        let now = unix_now_ms();
        let annotated = annotate_infos(&[payload.battery_info], now);
        record_history(&self.app, &previous, &annotated);
        emit_edge_notifications(
            &self.app,
            &self.snapshot.config,
            &previous,
            &previous.battery_infos,
            &annotated,
        );
        let mut next = previous;
        next.battery_infos = upsert_info(&next.battery_infos, annotated[0].clone());
        next.is_disconnected = false;
        next.connection_status_known = Some(true);
        next.connection_observed_at_unix_ms = Some(now);
        apply_collapse(&mut next, self.auto_collapse());
        self.snapshot.devices[index] = next;
        self.publish(false, true)
    }

    fn handle_monitor_status(
        &mut self,
        payload: ble::BatteryMonitorStatusEvent,
    ) -> Result<(), String> {
        if config_fetch_interval(&self.snapshot.config).is_some()
            || !is_current_monitor_session(
                &self.active_monitor_sessions,
                &payload.id,
                payload.session_id,
            )
        {
            return Ok(());
        }
        let Some(index) = self.device_index(&payload.id) else {
            return Ok(());
        };
        let previous = self.snapshot.devices[index].clone();
        let now = unix_now_ms();
        let mut next = previous.clone();
        let next_disconnected = !payload.connected;
        if next_disconnected
            && previous
                .battery_infos
                .iter()
                .any(|info| info.last_read_succeeded)
        {
            next.battery_infos = mark_infos_failed(&previous.battery_infos);
        }
        if previous.is_disconnected == next_disconnected
            && previous.connection_status_known == Some(true)
        {
            next.connection_observed_at_unix_ms = Some(now);
            self.snapshot.devices[index] = next;
            return self.publish(false, true);
        }
        next.is_disconnected = next_disconnected;
        next.connection_status_known = Some(true);
        next.connection_observed_at_unix_ms = Some(now);
        apply_collapse(&mut next, self.auto_collapse());
        if previous.connection_status_known != Some(false)
            || previous.is_disconnected != next_disconnected
        {
            emit_connection_notification(
                &self.app,
                &self.snapshot.config,
                &next,
                payload.connected,
            );
        }
        self.snapshot.devices[index] = next;
        self.publish(false, true)
    }
}

async fn read_poll_with_retries(
    id: &str,
    was_disconnected: bool,
) -> Result<Vec<ble::BatteryInfo>, String> {
    let max_attempts = if was_disconnected { 1 } else { 3 };
    let mut last_error = None;
    for attempt in 0..max_attempts {
        let read = tokio::time::timeout(
            Duration::from_secs(20),
            ble::get_battery_info(id.to_string()),
        )
        .await;
        match read {
            Ok(Ok(infos)) => return Ok(infos),
            Ok(Err(error)) => {
                last_error = Some(error);
                if attempt + 1 < max_attempts {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            Err(_) => {
                last_error = Some("Battery read timed out".to_string());
                if attempt + 1 < max_attempts {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Battery read failed".to_string()))
}

async fn send_request<T>(
    request: Request,
    receiver: oneshot::Receiver<Result<T, String>>,
) -> Result<T, String> {
    let service = service()?;
    service
        .tx
        .send(request)
        .await
        .map_err(|_| "Monitor service stopped".to_string())?;
    receiver
        .await
        .map_err(|_| "Monitor service stopped".to_string())?
}

#[tauri::command]
pub async fn get_monitor_state() -> Result<MonitorSnapshot, String> {
    current_snapshot().ok_or_else(|| "Monitor service is not initialized".to_string())
}

pub async fn patch_config(_app: &AppHandle, patch: Value) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::UpdateConfig { patch, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_update_config(patch: Value) -> Result<MonitorSnapshot, String> {
    patch_config_from_service(patch).await
}

#[tauri::command]
pub async fn monitor_is_update_dismissed(version: String) -> Result<bool, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::IsUpdateDismissed { version, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_dismiss_update(version: String) -> Result<(), String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::DismissUpdate { version, reply }, receiver).await
}

async fn patch_config_from_service(patch: Value) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::UpdateConfig { patch, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_add_device(device: ble::BleDeviceInfo) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::AddDevice { device, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_remove_device(id: String) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::RemoveDevice { id, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_set_device_display_name(
    id: String,
    display_name: Option<String>,
) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(
        Request::SetDeviceDisplayName {
            id,
            display_name,
            reply,
        },
        receiver,
    )
    .await
}

#[tauri::command]
pub async fn monitor_set_part_label(
    id: String,
    source_description: Option<String>,
    label: Option<String>,
) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(
        Request::SetPartLabel {
            id,
            source_description,
            label,
            reply,
        },
        receiver,
    )
    .await
}

#[tauri::command]
pub async fn monitor_set_device_collapsed(
    id: String,
    collapsed: bool,
) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(
        Request::SetDeviceCollapsed {
            id,
            collapsed,
            reply,
        },
        receiver,
    )
    .await
}

#[tauri::command]
pub async fn monitor_reorder_devices(ids: Vec<String>) -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::ReorderDevices { ids, reply }, receiver).await
}

#[tauri::command]
pub async fn monitor_reload() -> Result<MonitorSnapshot, String> {
    let (reply, receiver) = oneshot::channel();
    send_request(Request::Reload { reply }, receiver).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dismissed_versions_ignores_invalid_values() {
        assert_eq!(dismissed_versions(None), Vec::<String>::new());
        assert_eq!(
            dismissed_versions(Some(json!(["0.13.0", null, 12, "0.14.0"]))),
            vec!["0.13.0", "0.14.0"]
        );
    }

    fn info(level: Option<u8>, description: Option<&str>) -> MonitorBatteryInfo {
        MonitorBatteryInfo {
            battery_level: level,
            user_description: description.map(ToOwned::to_owned),
            observed_at_unix_ms: Some(1),
            last_read_succeeded: level.is_some(),
        }
    }

    #[test]
    fn normalize_config_preserves_unknown_fields_and_deep_merges_known_objects() {
        let normalized = normalize_config(Some(json!({
            "fetchInterval": "auto",
            "unknownSetting": {"enabled": true},
            "pushNotificationWhen": {"low_battery": false},
            "windowPosition": {"x": 42}
        })));
        assert_eq!(normalized["fetchInterval"], "auto");
        assert_eq!(normalized["unknownSetting"]["enabled"], true);
        assert_eq!(normalized["pushNotificationWhen"]["low_battery"], false);
        assert_eq!(normalized["pushNotificationWhen"]["high_battery"], true);
        assert_eq!(normalized["windowPosition"]["x"], 42);
        assert_eq!(normalized["windowPosition"]["y"], 0);
    }

    #[test]
    fn update_check_defaults_to_off_and_preserves_enabled_setting() {
        assert_eq!(normalize_config(None)["updateCheckEnabled"], false);
        assert_eq!(
            normalize_config(Some(json!({ "updateCheckEnabled": true })))["updateCheckEnabled"],
            true
        );
        assert_eq!(
            normalize_config(Some(json!({ "updateCheckEnabled": "true" })))["updateCheckEnabled"],
            false
        );
    }

    #[test]
    fn normalize_config_restores_default_order_for_overlapping_thresholds() {
        let normalized = normalize_config(Some(json!({
            "lowBatteryThreshold": 80,
            "highBatteryThreshold": 20
        })));
        assert_eq!(normalized["lowBatteryThreshold"], LOW_BATTERY_DEFAULT);
        assert_eq!(normalized["highBatteryThreshold"], HIGH_BATTERY_DEFAULT);
    }

    #[test]
    fn normalize_devices_preserves_order_and_legacy_descriptor() {
        let devices = normalize_devices(Some(json!([
            {
                "id": "DeviceId(\"a\")",
                "name": "DeviceId(\"Keyboard\")",
                "isCollapsed": true,
                "batteryInfos": [{"battery_level": 70, "user_descriptor": "Peripheral"}]
            },
            {"id": "b", "name": "Second", "batteryInfos": []}
        ])));
        assert_eq!(devices[0].id, "a");
        assert_eq!(devices[0].name, "Keyboard");
        assert_eq!(
            devices[0].battery_infos[0].user_description.as_deref(),
            Some("Peripheral")
        );
        assert!(devices[0].is_disconnected);
        assert_eq!(devices[1].id, "b");
    }

    #[test]
    fn merge_preserves_previous_value_for_invalid_read_by_description() {
        let previous = vec![info(Some(80), None), info(Some(60), Some("Peripheral"))];
        let next = vec![info(None, None), info(Some(55), Some("Peripheral"))];
        let merged = merge_infos(&previous, &next);
        assert_eq!(merged[0].battery_level, Some(80));
        assert!(!merged[0].last_read_succeeded);
        assert_eq!(merged[1].battery_level, Some(55));
    }

    #[test]
    fn edge_state_uses_array_index_not_description() {
        let previous = vec![info(Some(10), None), info(Some(50), Some("Peripheral"))];
        let current = vec![info(Some(10), Some("Peripheral"))];
        let config = normalize_config(Some(json!({
            "pushNotification": true,
            "lowBatteryThreshold": 20,
            "highBatteryThreshold": 80
        })));
        let low_previous = notification_low_state(&previous, 20, true);
        let low_current = notification_low_state(&current, 20, true);
        assert_eq!(low_previous, vec![true, false]);
        assert_eq!(low_current, vec![true]);
        let edges: Vec<usize> = low_current
            .iter()
            .enumerate()
            .take(low_previous.len())
            .filter_map(|(index, &is_low)| (!low_previous[index] && is_low).then_some(index))
            .collect();
        assert!(edges.is_empty());
        assert!(config["pushNotification"].as_bool().unwrap());
    }

    #[test]
    fn stale_monitor_session_does_not_match_current_session() {
        let active = HashMap::from([(String::from("device-1"), 9_u64)]);
        assert!(is_current_monitor_session(&active, "device-1", 9));
        assert!(!is_current_monitor_session(&active, "device-1", 8));
        assert!(!is_current_monitor_session(&active, "device-2", 9));
    }

    #[test]
    fn reorder_requires_exact_registered_id_set() {
        let devices = normalize_devices(Some(json!([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B"}
        ])));
        let expected: HashSet<&str> = devices.iter().map(|device| device.id.as_str()).collect();
        let actual: HashSet<&str> = ["a", "b"].iter().copied().collect();
        assert_eq!(expected, actual);
    }
}
