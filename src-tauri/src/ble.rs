use bluest::btuuid::descriptors::CHARACTERISTIC_USER_DESCRIPTION;
use bluest::Adapter;
use serde::Serialize;
use uuid::Uuid;

const BATTERY_SERVICE_UUID: Uuid = Uuid::from_u128(0x0000180F_0000_1000_8000_00805F9B34FB);
const BATTERY_LEVEL_UUID: Uuid = Uuid::from_u128(0x00002A19_0000_1000_8000_00805F9B34FB);

#[derive(Serialize)]
pub struct BleDeviceInfo {
    pub name: String,
    pub id: String,
}

#[derive(Serialize)]
pub struct BatteryInfo {
    pub battery_level: Option<u8>,
    pub user_descriptor: Option<String>, // User description
}

#[tauri::command]
pub async fn list_battery_devices() -> Result<Vec<BleDeviceInfo>, String> {
    let adapter = Adapter::default()
        .await
        .ok_or("Bluetooth adapter not found")
        .map_err(|e| e.to_string())?;
    adapter.wait_available().await.map_err(|e| e.to_string())?;
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
        let id = format!("{:?}", device.id());
        result.push(BleDeviceInfo { name, id });
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_battery_info(id: String) -> Result<Vec<BatteryInfo>, String> {
    let adapter = Adapter::default()
        .await
        .ok_or("Bluetooth adapter not found")
        .map_err(|e| e.to_string())?;
    adapter.wait_available().await.map_err(|e| e.to_string())?;
    let devices = adapter
        .connected_devices_with_services(&[BATTERY_SERVICE_UUID, BATTERY_LEVEL_UUID])
        .await
        .map_err(|e| e.to_string())?;
    let mut target_device = None;
    for device in devices.into_iter() {
        if format!("{:?}", device.id()) == id {
            target_device = Some(device);
            break;
        }
    }
    let device = target_device.ok_or("Device not found")?;
    adapter
        .connect_device(&device)
        .await
        .map_err(|e| e.to_string())?;
    let services = device.services().await.map_err(|e| e.to_string())?;
    let mut battery_infos = Vec::new();
    for service in services {
        if service.uuid() == BATTERY_SERVICE_UUID {
            let characteristics = service.characteristics().await.map_err(|e| e.to_string())?;
            for characteristic in characteristics {
                if characteristic.uuid() == BATTERY_LEVEL_UUID {
                    let value = characteristic.read().await.map_err(|e| e.to_string())?;
                    let battery_level = value.get(0).copied();
                    let mut user_descriptor = None;
                    let descriptors = characteristic
                        .descriptors()
                        .await
                        .map_err(|e| e.to_string())?;
                    for descriptor in descriptors {
                        if descriptor.uuid() == CHARACTERISTIC_USER_DESCRIPTION {
                            let desc_value = descriptor.read().await.map_err(|e| e.to_string())?;
                            if let Ok(desc_str) = String::from_utf8(desc_value.clone()) {
                                user_descriptor = Some(desc_str);
                            }
                        }
                    }
                    battery_infos.push(BatteryInfo {
                        battery_level,
                        user_descriptor,
                    });
                }
            }
        }
    }
    adapter.disconnect_device(&device).await.map_err(|e| e.to_string())?;
    Ok(battery_infos)
}
