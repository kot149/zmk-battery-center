use crate::ble::{BatteryInfo, BleDeviceInfo};
use crate::fast_pair_data::battery_levels;
use bluest::Adapter;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Duration, Instant};

const ID_PREFIX: &str = "fast-pair:";
const DISCOVERY_DURATION: Duration = Duration::from_secs(30);
const OBSERVATION_TTL: Duration = Duration::from_secs(90);

#[derive(Clone)]
struct Observation {
    device: BleDeviceInfo,
    levels: [Option<u8>; 3],
    received_at: Instant,
    unix_ms: u64,
}

#[derive(Clone, Default)]
pub(crate) struct Snapshot {
    observations: HashMap<String, Observation>,
    error: Option<String>,
}

impl Snapshot {
    fn prune(&mut self, now: Instant) {
        self.observations.retain(|_, observation| {
            now.duration_since(observation.received_at) <= OBSERVATION_TTL
        });
    }

    fn recent(&self, id: &str, now: Instant) -> Option<&Observation> {
        if self.error.is_some() {
            return None;
        }
        self.observations
            .get(id)
            .filter(|observation| now.duration_since(observation.received_at) <= OBSERVATION_TTL)
    }

    pub(crate) fn infos(&self, id: &str) -> Option<Vec<BatteryInfo>> {
        self.recent(id, Instant::now())
            .map(|observation| battery_infos(observation.levels, observation.unix_ms))
    }
}

pub(crate) type Receiver = watch::Receiver<Snapshot>;
static SESSION: LazyLock<Mutex<Option<watch::Sender<Snapshot>>>> =
    LazyLock::new(|| Mutex::new(None));

pub(crate) fn is_device(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

fn battery_infos(levels: [Option<u8>; 3], unix_ms: u64) -> Vec<BatteryInfo> {
    ["Left", "Right", "Case"]
        .into_iter()
        .zip(levels)
        .map(|(part, battery_level)| BatteryInfo {
            battery_level,
            user_description: Some(part.into()),
            observed_at_unix_ms: Some(unix_ms),
        })
        .collect()
}

pub(crate) fn subscribe() -> Receiver {
    let mut session = SESSION.lock().unwrap();
    if let Some(sender) = session
        .as_ref()
        .filter(|sender| sender.receiver_count() > 0)
    {
        return sender.subscribe();
    }
    let mut initial = session
        .as_ref()
        .map(|sender| sender.borrow().clone())
        .unwrap_or_default();
    initial.prune(Instant::now());
    initial.error = None;
    let (sender, receiver) = watch::channel(initial);
    *session = Some(sender.clone());
    tokio::spawn(run_scanner(sender));
    receiver
}

async fn scan_session(sender: &watch::Sender<Snapshot>) -> Result<(), String> {
    let adapter = Adapter::default()
        .await
        .ok_or("Bluetooth adapter not found")?;
    adapter
        .wait_available()
        .await
        .map_err(|error| error.to_string())?;
    // Fast Pair may put its UUID only in service data, not the advertised service list.
    let mut advertisements = adapter.scan(&[]).await.map_err(|error| error.to_string())?;
    let mut expiry = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
            biased;
            _ = sender.closed() => return Ok(()),
            _ = expiry.tick() => {
                sender.send_modify(|snapshot| snapshot.prune(Instant::now()));
            }
            advertisement = advertisements.next() => {
                let advertisement = advertisement.ok_or("Bluetooth advertisement scan ended")?;
                let Some(levels) = battery_levels(&advertisement.adv_data) else { continue };
                let id = format!("{ID_PREFIX}{}", advertisement.device.id());
                let name = advertisement.adv_data.local_name
                    .filter(|name| !name.is_empty())
                    .or_else(|| advertisement.device.name().ok().filter(|name| !name.is_empty()))
                    .unwrap_or_else(|| "Fast Pair device".into());
                let observation = Observation {
                    device: BleDeviceInfo { id: id.clone(), name: format!("{name} (Fast Pair)") },
                    levels, received_at: Instant::now(),
                    unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                };
                sender.send_modify(|snapshot| {
                    snapshot.error = None;
                    snapshot.observations.insert(id, observation);
                });
            }
        }
    }
}

async fn run_scanner(sender: watch::Sender<Snapshot>) {
    loop {
        let result = tokio::select! {
            biased;
            _ = sender.closed() => return,
            result = scan_session(&sender) => result,
        };
        if let Err(error) = result {
            log::warn!("Fast Pair scan failed: {error}");
            sender.send_modify(|snapshot| {
                snapshot.observations.clear();
                snapshot.error = Some(error);
            });
        }
        tokio::select! {
            _ = sender.closed() => return,
            _ = sleep(Duration::from_secs(2)) => {}
        }
    }
}

pub(crate) async fn list_devices() -> Result<Vec<BleDeviceInfo>, String> {
    let receiver = subscribe();
    sleep(DISCOVERY_DURATION).await;
    let mut snapshot = receiver.borrow().clone();
    snapshot.prune(Instant::now());
    if let Some(error) = snapshot.error {
        return Err(error);
    }
    let mut devices: Vec<_> = snapshot
        .observations
        .into_values()
        .map(|observation| observation.device)
        .collect();
    devices.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(devices)
}

pub(crate) async fn read(id: &str) -> Result<Vec<BatteryInfo>, String> {
    let mut receiver = subscribe();
    timeout(Duration::from_secs(18), async {
        loop {
            if let Some(infos) = receiver.borrow_and_update().infos(id) {
                return Ok(infos);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "Fast Pair scanner stopped".to_string())?;
        }
    })
    .await
    .map_err(|_| "No recent battery advertisement from this Fast Pair device".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scanner_stops_when_no_receivers_remain() {
        let (sender, receiver) = watch::channel(Snapshot::default());
        drop(receiver);
        timeout(Duration::from_millis(100), run_scanner(sender))
            .await
            .unwrap();
    }

    #[test]
    fn preserves_part_identity_unknown_values_and_receive_time() {
        let infos = battery_infos([Some(0), Some(52), None], 1234);
        assert_eq!(
            infos
                .iter()
                .map(|info| info.user_description.as_deref())
                .collect::<Vec<_>>(),
            [Some("Left"), Some("Right"), Some("Case")]
        );
        assert_eq!(
            infos
                .iter()
                .map(|info| info.battery_level)
                .collect::<Vec<_>>(),
            [Some(0), Some(52), None]
        );
        assert!(infos
            .iter()
            .all(|info| info.observed_at_unix_ms == Some(1234)));
    }

    #[test]
    fn expires_old_data_without_matching_devices_by_name() {
        let now = Instant::now();
        let mut snapshot = Snapshot::default();
        for (id, level) in [("fast-pair:first", 52), ("fast-pair:second", 12)] {
            snapshot.observations.insert(
                id.into(),
                Observation {
                    device: BleDeviceInfo {
                        id: id.into(),
                        name: "Earbuds".into(),
                    },
                    levels: [Some(level); 3],
                    received_at: now,
                    unix_ms: 1234,
                },
            );
        }
        assert_eq!(
            snapshot.recent("fast-pair:first", now).unwrap().levels,
            [Some(52); 3]
        );
        assert_eq!(
            snapshot.recent("fast-pair:second", now).unwrap().levels,
            [Some(12); 3]
        );
        assert!(snapshot.recent("fast-pair:rotated", now).is_none());
        assert!(snapshot
            .recent(
                "fast-pair:first",
                now + OBSERVATION_TTL + Duration::from_millis(1)
            )
            .is_none());
        snapshot.prune(now + OBSERVATION_TTL + Duration::from_millis(1));
        assert!(snapshot.observations.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires nearby WF-1000XM6 Fast Pair advertisements and Bluetooth access"]
    async fn app_commands_discover_and_read_fast_pair_battery() {
        let mut receiver = subscribe();
        let devices = crate::ble::list_battery_devices().await.unwrap();
        println!(
            "Discovered devices: {:?}",
            devices
                .iter()
                .map(|device| &device.name)
                .collect::<Vec<_>>()
        );
        let device = devices
            .into_iter()
            .find(|device| is_device(&device.id) && device.name.contains("WF-1000XM6"))
            .expect("WF-1000XM6 Fast Pair advertisement not found");
        let infos = crate::ble::get_battery_info(device.id.clone())
            .await
            .unwrap();
        assert_eq!(infos.len(), 3);
        println!("{}: {infos:?}", device.name);
        assert_eq!(
            infos
                .iter()
                .map(|info| info.user_description.as_deref())
                .collect::<Vec<_>>(),
            [Some("Left"), Some("Right"), Some("Case")]
        );
        assert!(infos
            .iter()
            .all(|info| info.battery_level.is_none_or(|level| level <= 100)));
        assert!(infos.iter().all(|info| info.observed_at_unix_ms.is_some()));
        timeout(Duration::from_secs(45), async {
            loop {
                receiver.changed().await.unwrap();
                let refreshed = receiver.borrow_and_update().infos(&device.id);
                if let Some(refreshed) = refreshed
                    .filter(|current| current[0].observed_at_unix_ms > infos[0].observed_at_unix_ms)
                {
                    println!("Fresh advertisement: {refreshed:?}");
                    break;
                }
            }
        })
        .await
        .expect("No fresh battery advertisement");
    }
}
