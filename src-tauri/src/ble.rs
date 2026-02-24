use bluest::btuuid::descriptors::CHARACTERISTIC_USER_DESCRIPTION;
use bluest::{Adapter, Characteristic, Device};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

const BATTERY_SERVICE_UUID: Uuid = Uuid::from_u128(0x0000180F_0000_1000_8000_00805F9B34FB);
const BATTERY_LEVEL_UUID: Uuid = Uuid::from_u128(0x00002A19_0000_1000_8000_00805F9B34FB);
const BATTERY_INFO_NOTIFICATION_EVENT: &str = "battery-info-notification";
const BATTERY_MONITOR_STATUS_EVENT: &str = "battery-monitor-status";

#[derive(Serialize)]
pub struct BleDeviceInfo {
    pub name: String,
    pub id: String,
}

#[derive(Serialize, Clone)]
pub struct BatteryInfo {
    pub battery_level: Option<u8>,
    pub user_descriptor: Option<String>, // User description
}

#[derive(Serialize, Clone)]
pub struct BatteryInfoNotificationEvent {
    pub id: String,
    pub battery_info: BatteryInfo,
}

#[derive(Serialize, Clone)]
pub struct BatteryMonitorStatusEvent {
    pub id: String,
    pub connected: bool,
}

#[derive(Clone)]
struct BatteryCharacteristicContext {
    characteristic: Characteristic,
    user_descriptor: Option<String>,
}

#[derive(Default)]
struct MonitorConnectionState {
    connected_workers: HashSet<usize>,
    is_connected: bool,
}

struct MonitorTask {
    stop_tx: watch::Sender<bool>,
    join_handles: Vec<JoinHandle<()>>,
}

static MONITORS: LazyLock<Mutex<HashMap<String, MonitorTask>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn bytes_to_hex(data: &[u8]) -> String {
    data.iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

async fn get_adapter() -> Result<Adapter, String> {
    log::debug!("BLE I/O: requesting default adapter");
    let adapter = Adapter::default()
        .await
        .ok_or("Bluetooth adapter not found")
        .map_err(|e| e.to_string())?;
    adapter.wait_available().await.map_err(|e| e.to_string())?;
    log::debug!("BLE I/O: adapter is available");
    Ok(adapter)
}

fn format_device_id_for_store(device: &Device) -> String {
    format!("{:?}", device.id())
}

fn is_target_device(device: &Device, id: &str) -> bool {
    let device_id = device.id();
    format!("{:?}", device_id) == id || device_id.to_string() == id
}

async fn get_target_device(adapter: &Adapter, id: &str) -> Result<Device, String> {
    log::debug!("BLE I/O: searching target device id={id}");
    let devices = adapter
        .connected_devices_with_services(&[BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID])
        .await
        .map_err(|e| e.to_string())?;

    let target = devices
        .iter()
        .find(|device| is_target_device(device, id))
        .cloned()
        .ok_or_else(|| "Device not found".to_string())?;

    let name = target
        .name()
        .unwrap_or_else(|_| "(unknown)".to_string());
    log::debug!(
        "BLE I/O: target device found id={} name={}",
        format_device_id_for_store(&target),
        name
    );

    Ok(target)
}

async fn get_battery_characteristic_contexts(
    target_device: &Device,
) -> Result<Vec<BatteryCharacteristicContext>, String> {
    let mut contexts = Vec::new();
    log::debug!(
        "BLE I/O: discovering battery services for device id={}",
        format_device_id_for_store(target_device)
    );
    let services = target_device.services().await.map_err(|e| e.to_string())?;

    for battery_service in services
        .iter()
        .filter(|service| service.uuid() == BATTERY_SERVICE_UUID)
    {
        let characteristics = battery_service
            .characteristics()
            .await
            .map_err(|e| e.to_string())?;

        for battery_level_characteristic in characteristics
            .iter()
            .filter(|c| c.uuid() == BATTERY_LEVEL_UUID)
        {
            log::debug!(
                "BLE I/O: found battery level characteristic for device id={}",
                format_device_id_for_store(target_device)
            );
            let mut user_description = None;
            let descriptors = battery_level_characteristic
                .descriptors()
                .await
                .map_err(|e| e.to_string())?;

            if let Some(user_description_descriptor) = descriptors
                .iter()
                .find(|d| d.uuid() == CHARACTERISTIC_USER_DESCRIPTION)
            {
                let desc_value = user_description_descriptor
                    .read()
                    .await
                    .map_err(|e| e.to_string())?;
                log::debug!(
                    "BLE I/O: read user descriptor bytes={} for device id={}",
                    bytes_to_hex(&desc_value),
                    format_device_id_for_store(target_device)
                );
                if let Ok(desc_str) = String::from_utf8(desc_value.clone()) {
                    user_description = Some(desc_str);
                }
            }

            contexts.push(BatteryCharacteristicContext {
                characteristic: battery_level_characteristic.clone(),
                user_descriptor: user_description,
            });
        }
    }

    Ok(contexts)
}

async fn read_battery_infos_strict(
    contexts: &[BatteryCharacteristicContext],
) -> Result<Vec<BatteryInfo>, String> {
    let mut battery_infos = Vec::new();

    for context in contexts {
        let label = context.user_descriptor.as_deref().unwrap_or("Central");
        log::debug!("BLE I/O: read request battery_level descriptor={label}");
        let value = context
            .characteristic
            .read()
            .await
            .map_err(|e| e.to_string())?;
        log::debug!(
            "BLE I/O: read response battery_level descriptor={} bytes={} parsed={:?}",
            label,
            bytes_to_hex(&value),
            value.first().copied()
        );
        battery_infos.push(BatteryInfo {
            battery_level: value.first().copied(),
            user_descriptor: context.user_descriptor.clone(),
        });
    }

    Ok(battery_infos)
}

async fn read_battery_infos_best_effort(contexts: &[BatteryCharacteristicContext]) -> Vec<BatteryInfo> {
    let mut battery_infos = Vec::new();

    for context in contexts {
        let label = context.user_descriptor.as_deref().unwrap_or("Central");
        log::debug!("BLE I/O: best-effort read request battery_level descriptor={label}");
        let read_result = context
            .characteristic
            .read()
            .await;
        let battery_level = read_result.as_ref().ok().and_then(|value| value.first().copied());
        match read_result {
            Ok(value) => {
                log::debug!(
                    "BLE I/O: best-effort read response descriptor={} bytes={} parsed={:?}",
                    label,
                    bytes_to_hex(&value),
                    battery_level
                );
            }
            Err(e) => {
                log::debug!(
                    "BLE I/O: best-effort read failed descriptor={} error={}",
                    label,
                    e
                );
            }
        }

        battery_infos.push(BatteryInfo {
            battery_level,
            user_descriptor: context.user_descriptor.clone(),
        });
    }

    battery_infos
}

async fn wait_for_retry_or_stop(stop_rx: &mut watch::Receiver<bool>, duration: Duration) -> bool {
    tokio::select! {
        _ = sleep(duration) => false,
        changed = stop_rx.changed() => changed.is_err() || *stop_rx.borrow(),
    }
}

async fn update_monitor_connection_state(
    app: &AppHandle,
    device_id: &str,
    worker_id: usize,
    connected: bool,
    state: &Arc<Mutex<MonitorConnectionState>>,
) {
    let state_changed = {
        let mut state_lock = state.lock().await;
        if connected {
            state_lock.connected_workers.insert(worker_id);
        } else {
            state_lock.connected_workers.remove(&worker_id);
        }

        let next_connected = !state_lock.connected_workers.is_empty();
        if next_connected != state_lock.is_connected {
            state_lock.is_connected = next_connected;
            Some(next_connected)
        } else {
            None
        }
    };

    if let Some(next_connected) = state_changed {
        let payload = BatteryMonitorStatusEvent {
            id: device_id.to_string(),
            connected: next_connected,
        };
        let _ = app.emit(BATTERY_MONITOR_STATUS_EVENT, payload);
    }
}

async fn battery_notification_worker(
    app: AppHandle,
    adapter: Adapter,
    target_device: Device,
    device_id: String,
    worker_id: usize,
    monitor_connection_state: Arc<Mutex<MonitorConnectionState>>,
    context: BatteryCharacteristicContext,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut is_worker_connected = false;

    loop {
        if *stop_rx.borrow() {
            log::debug!("BLE I/O: notification worker stopped by signal device_id={device_id}");
            return;
        }

        log::debug!("BLE I/O: connect request for notification monitor device_id={device_id}");
        if let Err(e) = adapter.connect_device(&target_device).await {
            log::warn!("Failed to connect device {} for notification monitor: {}", device_id, e);
            if is_worker_connected {
                is_worker_connected = false;
                update_monitor_connection_state(
                    &app,
                    &device_id,
                    worker_id,
                    false,
                    &monitor_connection_state,
                )
                .await;
            }
            if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                log::debug!("BLE I/O: notification worker disconnecting on stop (connect failed) device_id={device_id}");
                let _ = adapter.disconnect_device(&target_device).await;
                return;
            }
            continue;
        }
        log::debug!("BLE I/O: connect response success device_id={device_id}");

        // Subscribe to connection events
        let conn_events_result = adapter.device_connection_events(&target_device).await;
        let mut conn_events = match conn_events_result {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("BLE I/O: failed to subscribe to connection events device_id={device_id}: {e}");
                None
            }
        };

        log::debug!(
            "BLE I/O: notify subscribe request device_id={} descriptor={}",
            device_id,
            context.user_descriptor.as_deref().unwrap_or("Central")
        );
        let mut stream = match context.characteristic.notify().await {
            Ok(stream) => stream,
            Err(e) => {
                log::warn!(
                    "Failed to start notification stream for {} ({}): {}",
                    device_id,
                    context.user_descriptor.as_deref().unwrap_or("Central"),
                    e
                );
                if is_worker_connected {
                    is_worker_connected = false;
                    update_monitor_connection_state(
                        &app,
                        &device_id,
                        worker_id,
                        false,
                        &monitor_connection_state,
                    )
                    .await;
                }
                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                    log::debug!("BLE I/O: notification worker disconnecting on stop (notify failed) device_id={device_id}");
                    let _ = adapter.disconnect_device(&target_device).await;
                    return;
                }
                continue;
            }
        };
        log::debug!(
            "BLE I/O: notify subscribe response success device_id={} descriptor={}",
            device_id,
            context.user_descriptor.as_deref().unwrap_or("Central")
        );
        if !is_worker_connected {
            is_worker_connected = true;
            update_monitor_connection_state(
                &app,
                &device_id,
                worker_id,
                true,
                &monitor_connection_state,
            )
            .await;
        }

        loop {
            tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        log::debug!("BLE I/O: notification worker stop event device_id={device_id}");
                        log::debug!("BLE I/O: notification worker disconnecting on stop device_id={device_id}");
                        let _ = adapter.disconnect_device(&target_device).await;
                        return;
                    }
                }
                value = stream.next() => {
                    match value {
                        Some(Ok(data)) => {
                            log::debug!(
                                "BLE I/O: notify event device_id={} descriptor={} bytes={} parsed={:?}",
                                device_id,
                                context.user_descriptor.as_deref().unwrap_or("Central"),
                                bytes_to_hex(&data),
                                data.first().copied()
                            );
                            let payload = BatteryInfoNotificationEvent {
                                id: device_id.clone(),
                                battery_info: BatteryInfo {
                                    battery_level: data.first().copied(),
                                    user_descriptor: context.user_descriptor.clone(),
                                },
                            };
                            let _ = app.emit(BATTERY_INFO_NOTIFICATION_EVENT, payload);
                        }
                        Some(Err(e)) => {
                            log::warn!(
                                "Battery notification stream error for {} ({}): {}",
                                device_id,
                                context.user_descriptor.as_deref().unwrap_or("Central"),
                                e
                            );
                            if is_worker_connected {
                                is_worker_connected = false;
                                update_monitor_connection_state(
                                    &app,
                                    &device_id,
                                    worker_id,
                                    false,
                                    &monitor_connection_state,
                                )
                                .await;
                            }
                            break;
                        }
                        None => {
                            log::warn!(
                                "Battery notification stream ended for {} ({})",
                                device_id,
                                context.user_descriptor.as_deref().unwrap_or("Central")
                            );
                            if is_worker_connected {
                                is_worker_connected = false;
                                update_monitor_connection_state(
                                    &app,
                                    &device_id,
                                    worker_id,
                                    false,
                                    &monitor_connection_state,
                                )
                                .await;
                            }
                            break;
                        }
                    }
                }
                // Detect disconnection
                conn_event = async {
                    match conn_events.as_mut() {
                        Some(s) => s.next().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if matches!(conn_event, Some(bluest::ConnectionEvent::Disconnected) | None) {
                        log::warn!(
                            "BLE I/O: device disconnected (connection event) device_id={} descriptor={}",
                            device_id,
                            context.user_descriptor.as_deref().unwrap_or("Central")
                        );
                        if is_worker_connected {
                            is_worker_connected = false;
                            update_monitor_connection_state(
                                &app,
                                &device_id,
                                worker_id,
                                false,
                                &monitor_connection_state,
                            )
                            .await;
                        }
                        break;
                    }
                }
            }
        }

        if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
            log::debug!("BLE I/O: notification worker disconnecting on stop (stream ended) device_id={device_id}");
            let _ = adapter.disconnect_device(&target_device).await;
            return;
        }
    }
}

async fn battery_connection_watcher(
    app: AppHandle,
    adapter: Adapter,
    device_id: String,
    mut stop_rx: watch::Receiver<bool>,
) {
    log::debug!("BLE I/O: connection watcher started device_id={device_id}");

    'outer: loop {
        if *stop_rx.borrow() {
            log::debug!("BLE I/O: connection watcher stopped by signal device_id={device_id}");
            return;
        }

        // obtain a Device handle via discover_devices.
        // connected devices are yielded first; unconnected ones appear once BLE scanning begins.
        log::debug!("BLE I/O: connection watcher starting discover_devices device_id={device_id}");
        let mut discover = match adapter
            .discover_devices(&[BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID])
            .await
        {
            Ok(s) => s,
            Err(e) => {
                log::warn!("BLE I/O: connection watcher discover_devices failed device_id={device_id}: {e}");
                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(5)).await {
                    return;
                }
                continue 'outer;
            }
        };

        // Wait until the target device appears in the stream.
        let target_device = loop {
            tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        return;
                    }
                }
                result = discover.next() => {
                    match result {
                        Some(Ok(device)) if is_target_device(&device, &device_id) => {
                            log::debug!("BLE I/O: connection watcher found target device device_id={device_id}");
                            break device;
                        }
                        Some(Ok(_)) => {} // not our target
                        Some(Err(e)) => {
                            log::warn!("BLE I/O: connection watcher discover error device_id={device_id}: {e}");
                        }
                        None => {
                            log::warn!("BLE I/O: connection watcher discover stream ended device_id={device_id}");
                            if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                                return;
                            }
                            continue 'outer;
                        }
                    }
                }
            }
        };
        drop(discover); // stop scanning

        log::debug!("BLE I/O: connection watcher calling connect_device device_id={device_id}");
        // On macOS, bluest connection should be Established before subscribing to device_connection_events().
        // See https://docs.rs/bluest/latest/bluest/struct.Adapter.html#method.device_connection_events
        if let Err(e) = adapter.connect_device(&target_device).await {
            log::warn!("BLE I/O: connection watcher connect_device failed device_id={device_id}: {e}");
            if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                return;
            }
            continue 'outer;
        }

        let mut conn_events = match adapter.device_connection_events(&target_device).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("BLE I/O: connection watcher failed to subscribe to connection events device_id={device_id}: {e}");
                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                    let _ = adapter.disconnect_device(&target_device).await;
                    return;
                }
                continue 'outer;
            }
        };

        // Check whether the device is already connected (returned in the connected-first batch).
        let already_connected = adapter
            .connected_devices_with_services(&[BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID])
            .await
            .map(|devs| devs.iter().any(|d| is_target_device(d, &device_id)))
            .unwrap_or(false);

        if !already_connected {
            // Wait for ConnectionEvent::Connected.
            log::debug!("BLE I/O: connection watcher waiting for ConnectionEvent::Connected device_id={device_id}");
            loop {
                tokio::select! {
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            let _ = adapter.disconnect_device(&target_device).await;
                            return;
                        }
                    }
                    event = conn_events.next() => {
                        match event {
                            Some(bluest::ConnectionEvent::Connected) => {
                                log::debug!("BLE I/O: connection watcher got ConnectionEvent::Connected device_id={device_id}");
                                break;
                            }
                            Some(bluest::ConnectionEvent::Disconnected) => {
                                log::debug!("BLE I/O: connection watcher got Disconnected while waiting device_id={device_id}");
                                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                                    let _ = adapter.disconnect_device(&target_device).await;
                                    return;
                                }
                                continue 'outer;
                            }
                            None => {
                                log::warn!("BLE I/O: connection watcher connection events stream ended device_id={device_id}");
                                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                                    let _ = adapter.disconnect_device(&target_device).await;
                                    return;
                                }
                                continue 'outer;
                            }
                        }
                    }
                }
            }
        } else {
            log::debug!("BLE I/O: connection watcher device already connected device_id={device_id}");
        }

        let contexts = match get_battery_characteristic_contexts(&target_device).await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("BLE I/O: connection watcher failed to get characteristics device_id={device_id}: {e}");
                if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
                    let _ = adapter.disconnect_device(&target_device).await;
                    return;
                }
                continue 'outer;
            }
        };

        let mut notify_contexts = Vec::new();
        for context in contexts.iter().cloned() {
            match context.characteristic.properties().await {
                Ok(props) if props.notify || props.indicate => notify_contexts.push(context),
                _ => {}
            }
        }

        if notify_contexts.is_empty() {
            log::warn!("BLE I/O: connection watcher no notify characteristics device_id={device_id}");
            if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(5)).await {
                let _ = adapter.disconnect_device(&target_device).await;
                return;
            }
            continue 'outer;
        }

        // Send initial battery readings to the frontend.
        let initial_infos = read_battery_infos_best_effort(&contexts).await;
        for info in &initial_infos {
            let _ = app.emit(
                BATTERY_INFO_NOTIFICATION_EVENT,
                BatteryInfoNotificationEvent {
                    id: device_id.clone(),
                    battery_info: info.clone(),
                },
            );
        }

        log::debug!(
            "BLE I/O: connection watcher starting {} workers device_id={device_id}",
            notify_contexts.len()
        );

        let monitor_connection_state = Arc::new(Mutex::new(MonitorConnectionState::default()));
        let mut sub_handles = Vec::new();

        for (worker_id, context) in notify_contexts.into_iter().enumerate() {
            let app_c = app.clone();
            let adapter_c = adapter.clone();
            let device_c = target_device.clone();
            let id_c = device_id.clone();
            let stop_rx_c = stop_rx.clone();
            let state_c = monitor_connection_state.clone();

            sub_handles.push(tokio::spawn(async move {
                battery_notification_worker(
                    app_c,
                    adapter_c,
                    device_c,
                    id_c,
                    worker_id,
                    state_c,
                    context,
                    stop_rx_c,
                )
                .await;
            }));
        }

        // Wait for all sub-workers to finish (disconnection or stop signal).
        for h in sub_handles {
            let _ = h.await;
        }

        log::debug!("BLE I/O: connection watcher all workers finished, restarting device_id={device_id}");

        if *stop_rx.borrow() {
            let _ = adapter.disconnect_device(&target_device).await;
            return;
        }
        if wait_for_retry_or_stop(&mut stop_rx, Duration::from_secs(2)).await {
            let _ = adapter.disconnect_device(&target_device).await;
            return;
        }
    }
}

async fn stop_battery_notification_monitor_internal(id: &str) {
    let monitor = {
        let mut monitors = MONITORS.lock().await;
        monitors.remove(id)
    };

    if let Some(monitor) = monitor {
        let _ = monitor.stop_tx.send(true);
        for handle in monitor.join_handles {
            let abort_handle = handle.abort_handle();
            if tokio::time::timeout(Duration::from_secs(10), handle).await.is_err() {
                log::warn!("BLE I/O: notification worker did not stop in time, aborting");
                abort_handle.abort();
            }
        }
    }
}

#[tauri::command]
pub async fn list_battery_devices() -> Result<Vec<BleDeviceInfo>, String> {
    let adapter = get_adapter().await?;

    log::debug!("BLE I/O: list connected battery devices request");
    let devices = adapter
        .connected_devices_with_services(&[BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID])
        .await
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();

    for device in devices.into_iter() {
        let name = match device.name() {
            Ok(n) => n.to_string(),
            Err(_) => continue,
        };
        let id = format_device_id_for_store(&device);
        result.push(BleDeviceInfo { name, id });
    }
    log::debug!("BLE I/O: list connected battery devices response count={}", result.len());

    Ok(result)
}

#[tauri::command]
pub async fn get_battery_info(id: String) -> Result<Vec<BatteryInfo>, String> {
    let adapter = get_adapter().await?;
    let target_device = get_target_device(&adapter, &id).await?;

    log::debug!("BLE I/O: connect request (polling) device_id={id}");
    adapter
        .connect_device(&target_device)
        .await
        .map_err(|e| e.to_string())?;
    log::debug!("BLE I/O: connect response success (polling) device_id={id}");

    let contexts = get_battery_characteristic_contexts(&target_device).await?;
    let battery_infos = read_battery_infos_strict(&contexts).await?;

    log::debug!("BLE I/O: disconnect request (polling) device_id={id}");
    adapter
        .disconnect_device(&target_device)
        .await
        .map_err(|e| e.to_string())?;
    log::debug!("BLE I/O: disconnect response success (polling) device_id={id}");

    Ok(battery_infos)
}

#[tauri::command]
pub async fn start_battery_notification_monitor(
    app: AppHandle,
    id: String,
) -> Result<Vec<BatteryInfo>, String> {
    log::debug!("BLE I/O: start notification monitor request device_id={}", id);
    let adapter = get_adapter().await?;

    stop_battery_notification_monitor_internal(&id).await;

    let (stop_tx, stop_rx) = watch::channel(false);
    let join_handles;
    let initial_battery_infos;

    match get_target_device(&adapter, &id).await {
        Ok(target_device) => {
            log::debug!("BLE I/O: connect request (notification) device_id={id}");
            adapter
                .connect_device(&target_device)
                .await
                .map_err(|e| e.to_string())?;
            log::debug!("BLE I/O: connect response success (notification) device_id={id}");

            let contexts = get_battery_characteristic_contexts(&target_device).await?;
            if contexts.is_empty() {
                return Err("Battery level characteristic not found".to_string());
            }

            initial_battery_infos = read_battery_infos_best_effort(&contexts).await;

            let mut notify_contexts = Vec::new();
            for context in contexts.iter().cloned() {
                let properties = context
                    .characteristic
                    .properties()
                    .await
                    .map_err(|e| e.to_string())?;
                if properties.notify || properties.indicate {
                    notify_contexts.push(context);
                }
            }

            if notify_contexts.is_empty() {
                return Err(
                    "Battery level notification is not supported by this device".to_string(),
                );
            }

            log::debug!(
                "BLE I/O: notification characteristics ready device_id={} total={} notify_capable={}",
                id,
                contexts.len(),
                notify_contexts.len()
            );

            let monitor_connection_state =
                Arc::new(Mutex::new(MonitorConnectionState::default()));
            let mut handles = Vec::new();

            for (worker_id, context) in notify_contexts.into_iter().enumerate() {
                let app_cloned = app.clone();
                let adapter_cloned = adapter.clone();
                let device_cloned = target_device.clone();
                let id_cloned = id.clone();
                let stop_rx_cloned = stop_rx.clone();
                let connection_state_cloned = monitor_connection_state.clone();

                handles.push(tokio::spawn(async move {
                    battery_notification_worker(
                        app_cloned,
                        adapter_cloned,
                        device_cloned,
                        id_cloned,
                        worker_id,
                        connection_state_cloned,
                        context,
                        stop_rx_cloned,
                    )
                    .await;
                }));
            }
            join_handles = handles;
        }
        Err(e) => {
            // Device is not connected yet. Start a connection watcher that uses
            // discover_devices to obtain a Device handle and then listens for
            // ConnectionEvent::Connected before starting the notification workers.
            log::info!(
                "BLE I/O: device not found, starting connection watcher device_id={id}: {e}"
            );
            initial_battery_infos = vec![];

            let app_c = app.clone();
            let adapter_c = adapter.clone();
            let id_c = id.clone();
            let stop_rx_c = stop_rx.clone();

            join_handles = vec![tokio::spawn(async move {
                battery_connection_watcher(app_c, adapter_c, id_c, stop_rx_c).await;
            })];
        }
    }

    {
        let mut monitors = MONITORS.lock().await;
        monitors.insert(id, MonitorTask { stop_tx, join_handles });
    }

    log::debug!("BLE I/O: start notification monitor response success");

    Ok(initial_battery_infos)
}

#[tauri::command]
pub async fn stop_battery_notification_monitor(id: String) -> Result<(), String> {
    log::debug!("BLE I/O: stop notification monitor request device_id={id}");
    stop_battery_notification_monitor_internal(&id).await;
    log::debug!("BLE I/O: stop notification monitor response success device_id={id}");
    Ok(())
}
