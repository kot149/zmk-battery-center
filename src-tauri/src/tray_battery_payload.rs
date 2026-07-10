use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_full_camel_case_payload() {
        let json = r#"{
            "enabled": true,
            "components": ["roleLabel", "batteryPercent"],
            "rowCount": 1,
            "centralPercent": 85,
            "peripheralPercent": null,
            "centralLabel": "C",
            "peripheralLabel": null,
            "disconnected": false
        }"#;
        let p: TrayBatteryPayload = serde_json::from_str(json).expect("deserialize");
        assert!(p.enabled);
        assert_eq!(
            p.components,
            vec![TrayIconComponent::RoleLabel, TrayIconComponent::BatteryPercent]
        );
        assert_eq!(p.row_count, 1);
        assert_eq!(p.central_percent, Some(85));
        assert_eq!(p.peripheral_percent, None);
        assert_eq!(p.central_label.as_deref(), Some("C"));
        assert!(!p.disconnected);
    }

    #[test]
    fn missing_components_and_row_count_use_defaults() {
        let json = r#"{
            "enabled": true,
            "centralPercent": null,
            "peripheralPercent": null,
            "centralLabel": null,
            "peripheralLabel": null,
            "disconnected": true
        }"#;
        let p: TrayBatteryPayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(p.row_count, 2);
        assert_eq!(
            p.components,
            vec![
                TrayIconComponent::RoleLabel,
                TrayIconComponent::BatteryIcon,
                TrayIconComponent::BatteryPercent
            ]
        );
        assert!(p.disconnected);
    }

    #[test]
    fn unknown_component_variant_is_an_error() {
        let json = r#"{"enabled": true, "components": ["sparkles"], "centralPercent": null,
            "peripheralPercent": null, "centralLabel": null, "peripheralLabel": null, "disconnected": false}"#;
        assert!(serde_json::from_str::<TrayBatteryPayload>(json).is_err());
    }
}
