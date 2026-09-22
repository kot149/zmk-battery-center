#[cfg(any(target_os = "macos", test))]
use crate::monitor::MonitorBatteryInfo;
use crate::monitor::MonitorSnapshot;
use serde::Deserialize;
#[cfg(any(target_os = "macos", test))]
use std::collections::HashMap;
use tauri::AppHandle;

fn default_row_count() -> u8 {
    2
}

fn default_components() -> Vec<TrayIconComponent> {
    vec![
        TrayIconComponent::RoleLabel,
        TrayIconComponent::BatteryIcon,
        TrayIconComponent::BatteryPercent,
    ]
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrayIconComponent {
    AppIcon,
    RoleLabel,
    BatteryIcon,
    BatteryPercent,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TrayBatteryPayload {
    pub enabled: bool,
    #[serde(default = "default_components")]
    pub components: Vec<TrayIconComponent>,
    #[serde(default = "default_row_count")]
    pub row_count: u8,
    pub central_percent: Option<u8>,
    pub peripheral_percent: Option<u8>,
    pub central_label: Option<String>,
    pub peripheral_label: Option<String>,
    pub disconnected: bool,
}

#[cfg(any(target_os = "macos", test))]
fn config_components(config: &serde_json::Value) -> Vec<TrayIconComponent> {
    let components = config
        .get("trayIconComponents")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| match value.as_str()? {
                    "appIcon" => Some(TrayIconComponent::AppIcon),
                    "roleLabel" => Some(TrayIconComponent::RoleLabel),
                    "batteryIcon" => Some(TrayIconComponent::BatteryIcon),
                    "batteryPercent" => Some(TrayIconComponent::BatteryPercent),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if components.is_empty() {
        vec![TrayIconComponent::RoleLabel]
    } else {
        components
    }
}

#[cfg(any(target_os = "macos", test))]
fn storage_key(description: Option<&str>) -> &str {
    description.unwrap_or("Central")
}

#[cfg(any(target_os = "macos", test))]
fn custom_label(
    labels: Option<&HashMap<String, String>>,
    description: Option<&str>,
) -> Option<String> {
    labels
        .and_then(|labels| labels.get(storage_key(description)))
        .map(|label| label.trim())
        .filter(|label| !label.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(any(target_os = "macos", test))]
fn first_uppercase(value: &str) -> String {
    value
        .chars()
        .next()
        .map(|character| character.to_uppercase().collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", test))]
fn info_label(info: Option<&MonitorBatteryInfo>, fallback: &str) -> String {
    let Some(description) = info.and_then(|info| info.user_description.as_deref()) else {
        return first_uppercase(fallback);
    };
    let trimmed = description.trim();
    let mut characters = trimmed.chars();
    match (characters.next(), characters.next()) {
        (Some(character), None) => character.to_uppercase().collect(),
        _ if trimmed.eq_ignore_ascii_case("central") => "C".to_string(),
        _ if trimmed.eq_ignore_ascii_case("peripheral") => "P".to_string(),
        _ => first_uppercase(trimmed),
    }
}

#[cfg(any(target_os = "macos", test))]
fn glyph_for_info(
    info: Option<&MonitorBatteryInfo>,
    fallback: &str,
    labels: Option<&HashMap<String, String>>,
) -> String {
    if let Some(custom) = custom_label(
        labels,
        info.and_then(|info| info.user_description.as_deref()),
    ) {
        return first_uppercase(&custom);
    }
    info_label(info, fallback)
}

#[cfg(any(target_os = "macos", test))]
pub fn payload_from_snapshot(snapshot: &MonitorSnapshot) -> TrayBatteryPayload {
    let components = config_components(&snapshot.config);
    let Some(device) = snapshot.devices.first() else {
        return TrayBatteryPayload {
            enabled: false,
            components,
            row_count: 1,
            central_percent: None,
            peripheral_percent: None,
            central_label: None,
            peripheral_label: None,
            disconnected: false,
        };
    };

    let first = device.battery_infos.first();
    let second = device.battery_infos.get(1);
    match device.battery_infos.len() {
        0 => TrayBatteryPayload {
            enabled: true,
            components,
            row_count: 1,
            central_percent: None,
            peripheral_percent: None,
            central_label: Some(glyph_for_info(
                None,
                "Central",
                device.battery_part_labels.as_ref(),
            )),
            peripheral_label: None,
            disconnected: device.is_disconnected,
        },
        1 => TrayBatteryPayload {
            enabled: true,
            components,
            row_count: 1,
            central_percent: first.and_then(|info| info.battery_level),
            peripheral_percent: None,
            central_label: Some(glyph_for_info(
                first,
                "Central",
                device.battery_part_labels.as_ref(),
            )),
            peripheral_label: None,
            disconnected: device.is_disconnected,
        },
        _ => TrayBatteryPayload {
            enabled: true,
            components,
            row_count: 2,
            central_percent: first.and_then(|info| info.battery_level),
            peripheral_percent: second.and_then(|info| info.battery_level),
            central_label: Some(glyph_for_info(
                first,
                "Central",
                device.battery_part_labels.as_ref(),
            )),
            peripheral_label: Some(glyph_for_info(
                second,
                "Peripheral",
                device.battery_part_labels.as_ref(),
            )),
            disconnected: device.is_disconnected,
        },
    }
}

pub fn refresh(app: &AppHandle, snapshot: &MonitorSnapshot) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::tray::update_tray_battery_icon(app.clone(), payload_from_snapshot(snapshot))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, snapshot);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::MonitorDevice;
    use serde_json::json;

    fn snapshot(config: serde_json::Value, devices: Vec<MonitorDevice>) -> MonitorSnapshot {
        MonitorSnapshot {
            revision: 1,
            config,
            devices,
        }
    }

    fn device(infos: Vec<MonitorBatteryInfo>) -> MonitorDevice {
        MonitorDevice {
            id: "id".into(),
            name: "Keyboard".into(),
            display_name: None,
            battery_infos: infos,
            is_disconnected: false,
            is_collapsed: false,
            connection_status_known: Some(true),
            connection_observed_at_unix_ms: Some(1),
            battery_part_labels: None,
            extra: serde_json::Map::new(),
        }
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
    fn no_devices_disable_tray_payload() {
        let payload = payload_from_snapshot(&snapshot(json!({}), vec![]));
        assert!(!payload.enabled);
        assert_eq!(payload.row_count, 1);
    }

    #[test]
    fn one_part_uses_central_row_and_custom_glyph() {
        let mut d = device(vec![info(Some(84), None)]);
        d.battery_part_labels = Some(HashMap::from([("Central".into(), "Left".into())]));
        let payload = payload_from_snapshot(&snapshot(json!({}), vec![d]));
        assert_eq!(payload.row_count, 1);
        assert_eq!(payload.central_percent, Some(84));
        assert_eq!(payload.central_label.as_deref(), Some("L"));
        assert_eq!(payload.peripheral_percent, None);
    }

    #[test]
    fn two_parts_keep_vec_order_and_use_first_two_only() {
        let payload = payload_from_snapshot(&snapshot(
            json!({"trayIconComponents": ["batteryPercent"]}),
            vec![device(vec![
                info(Some(70), None),
                info(Some(60), Some("Peripheral 0")),
                info(Some(50), Some("Peripheral 1")),
            ])],
        ));
        assert_eq!(payload.row_count, 2);
        assert_eq!(payload.central_percent, Some(70));
        assert_eq!(payload.peripheral_percent, Some(60));
        assert_eq!(payload.central_label.as_deref(), Some("C"));
        assert_eq!(payload.peripheral_label.as_deref(), Some("P"));
        assert_eq!(payload.components, vec![TrayIconComponent::BatteryPercent]);
    }

    #[test]
    fn empty_component_config_falls_back_to_role_label() {
        let payload = payload_from_snapshot(&snapshot(
            json!({"trayIconComponents": []}),
            vec![device(vec![])],
        ));
        assert_eq!(payload.components, vec![TrayIconComponent::RoleLabel]);
    }
}
