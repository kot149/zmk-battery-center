use crate::ble::{BatteryInfo, BleDeviceInfo};
use std::collections::HashSet;
use windows::core::{Interface, HSTRING};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationKind};
use windows::Foundation::IPropertyValue;

const ID_PREFIX: &str = "windows-battery:";
const BATTERY_PROPERTY: &str = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";

pub(crate) fn is_device(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

fn service_address(instance_id: &str) -> Option<u64> {
    let id = instance_id.to_ascii_uppercase();
    if !id.starts_with("BTHENUM\\{") {
        return None;
    }
    let instance = id.rsplit('\\').next()?;
    instance.split('&').find_map(|part| {
        let (address, suffix) = part.split_once('_')?;
        (address.len() == 12 && suffix.starts_with('C'))
            .then(|| u64::from_str_radix(address, 16).ok())
            .flatten()
    })
}

fn battery_level(value: &IPropertyValue) -> Option<u8> {
    let level = value.GetUInt8().ok()?;
    (level <= 100).then_some(level)
}

async fn enumerate() -> windows::core::Result<Vec<(BleDeviceInfo, BatteryInfo)>> {
    let operation = {
        let properties: windows_collections::IIterable<HSTRING> =
            vec![HSTRING::from(BATTERY_PROPERTY)].into();
        DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
            &HSTRING::new(),
            &properties,
            DeviceInformationKind::Device,
        )?
    };
    let nodes = operation.await?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for index in 0..nodes.Size()? {
        let node = nodes.GetAt(index)?;
        let Some(address) = service_address(&node.Id()?.to_string()) else {
            continue;
        };
        let level = node
            .Properties()?
            .Lookup(&HSTRING::from(BATTERY_PROPERTY))
            .ok()
            .and_then(|value| value.cast::<IPropertyValue>().ok())
            .and_then(|value| battery_level(&value));
        let Some(level) = level else { continue };
        if seen.contains(&address) {
            continue;
        }
        let device = match BluetoothDevice::FromBluetoothAddressAsync(address)?.await {
            Ok(device) => device,
            Err(_) => continue,
        };
        let connected = device.ConnectionStatus()? == BluetoothConnectionStatus::Connected;
        let name = device.Name()?.to_string();
        device.Close()?;
        if !connected {
            continue;
        }
        seen.insert(address);
        result.push((
            BleDeviceInfo {
                name,
                id: format!("{ID_PREFIX}{address:012X}"),
            },
            BatteryInfo {
                battery_level: Some(level),
                user_description: None,
                observed_at_unix_ms: None,
            },
        ));
    }
    Ok(result)
}

pub(crate) async fn list_devices() -> Result<Vec<BleDeviceInfo>, String> {
    enumerate()
        .await
        .map(|devices| devices.into_iter().map(|(device, _)| device).collect())
        .map_err(|error| error.to_string())
}

pub(crate) async fn read(id: &str) -> Result<Vec<BatteryInfo>, String> {
    enumerate()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|(device, _)| device.id == id)
        .map(|(_, info)| vec![info])
        .ok_or_else(|| "Windows Bluetooth battery is unavailable or device is disconnected".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Foundation::PropertyValue;

    #[test]
    fn parses_classic_service_address_only() {
        assert_eq!(
            service_address(
                r"BTHENUM\{0000111E-0000-1000-8000-00805F9B34FB}_VID&00020000_PID&0000\7&12345678&0&112233445566_C00000000"
            ),
            Some(0x112233445566)
        );
        assert_eq!(
            service_address(r"BTHENUM\DEV_112233445566\7&0&BLUETOOTHDEVICE_112233445566"),
            None
        );
        assert_eq!(
            service_address(r"BTHLE\{SERVICE}\0&112233445566_C00000000"),
            None
        );
        assert_eq!(
            service_address(r"BTHENUM\{SERVICE}\0&XXXXXXXXXXXX_C00000000"),
            None
        );
    }

    #[test]
    fn validates_windows_battery_property() {
        for (input, expected) in [
            (0, Some(0)),
            (52, Some(52)),
            (100, Some(100)),
            (101, None),
            (255, None),
        ] {
            let value = PropertyValue::CreateUInt8(input).unwrap().cast().unwrap();
            assert_eq!(battery_level(&value), expected);
        }
        let value = PropertyValue::CreateString(&HSTRING::from("52"))
            .unwrap()
            .cast()
            .unwrap();
        assert_eq!(battery_level(&value), None);
    }

    #[tokio::test]
    #[ignore = "requires connected Windows Bluetooth hardware"]
    async fn inspect_connected_batteries() {
        let devices = enumerate().await.unwrap();
        assert!(!devices.is_empty(), "No connected Windows battery devices");
        let listed = crate::ble::list_battery_devices().await.unwrap();
        for (device, info) in devices {
            assert!(listed.iter().any(|entry| entry.id == device.id));
            println!("{}: {:?}", device.name, info.battery_level);
            assert_eq!(
                crate::ble::get_battery_info(device.id).await.unwrap()[0].battery_level,
                info.battery_level
            );
        }
    }
}
