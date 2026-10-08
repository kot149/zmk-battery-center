use bluest::{Adapter, Device};
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use tokio::time::{timeout, Duration, Instant};
use uuid::Uuid;

const BATTERY_SERVICE: Uuid = Uuid::from_u128(0x0000180f_0000_1000_8000_00805f9b34fb);
const BATTERY_LEVEL: Uuid = Uuid::from_u128(0x00002a19_0000_1000_8000_00805f9b34fb);
#[path = "../src/fast_pair_data.rs"]
mod fast_pair_data;

async fn inspect(device: Device) {
    println!(
        "Inspecting {} ({})",
        device.name().unwrap_or_default(),
        device.id()
    );
    match timeout(Duration::from_secs(20), device.discover_services()).await {
        Ok(Ok(services)) => {
            println!("GATT services: {}", services.len());
            println!(
                "Standard Battery Service present: {}",
                services
                    .iter()
                    .any(|service| service.uuid() == BATTERY_SERVICE)
            );
            for service in services {
                println!("Service {}", service.uuid());
                if service.uuid() != BATTERY_SERVICE {
                    continue;
                }
                match timeout(Duration::from_secs(10), service.discover_characteristics()).await {
                    Ok(Ok(characteristics)) => {
                        for characteristic in characteristics {
                            println!(
                                "  Characteristic {} {:?}",
                                characteristic.uuid(),
                                characteristic.properties().await
                            );
                            if service.uuid() == BATTERY_SERVICE
                                && characteristic.uuid() == BATTERY_LEVEL
                            {
                                println!(
                                    "  Battery read: {:?}",
                                    timeout(Duration::from_secs(10), characteristic.read()).await
                                );
                            }
                        }
                    }
                    result => println!("  Characteristic discovery: {result:?}"),
                }
            }
        }
        result => println!("Service discovery: {result:?}"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "WF-1000XM6".into())
        .to_ascii_lowercase();
    let adapter = Adapter::default().await.ok_or("No adapter")?;
    timeout(Duration::from_secs(10), adapter.wait_available()).await??;
    let mut candidates = HashMap::new();
    let connected = timeout(Duration::from_secs(10), adapter.connected_devices()).await??;
    println!("Connected BLE devices: {}", connected.len());
    for device in connected {
        if device
            .name()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains(&target)
        {
            println!("Target already connected over BLE");
            candidates.insert(device.id().to_string(), device);
        }
    }
    let mut seen = HashSet::new();
    let mut battery_packets = 0;
    let mut scan = adapter.scan(&[]).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while let Ok(Some(found)) = tokio::time::timeout_at(deadline, scan.next()).await {
        let name = found
            .adv_data
            .local_name
            .clone()
            .unwrap_or_else(|| found.device.name().unwrap_or_default());
        let key = found.device.id().to_string();
        if name.to_ascii_lowercase().contains(&target) {
            if candidates
                .insert(key.clone(), found.device.clone())
                .is_none()
            {
                println!(
                    "Target advertisement: name={name:?}, data={:?}",
                    found.adv_data
                );
            }
            if let Some([left, right, case]) = fast_pair_data::battery_levels(&found.adv_data) {
                battery_packets += 1;
                if battery_packets <= 3 {
                    println!("Fast Pair battery: left={left:?}, right={right:?}, case={case:?}");
                }
            }
        }
        seen.insert(key);
    }
    drop(scan);
    println!(
        "Scan complete: {} unique BLE devices, {} target candidates",
        seen.len(),
        candidates.len()
    );
    println!("Target battery advertisements received: {battery_packets}");
    for device in candidates.into_values() {
        timeout(Duration::from_secs(10), adapter.connect_device(&device)).await??;
        inspect(device).await;
    }
    Ok(())
}
