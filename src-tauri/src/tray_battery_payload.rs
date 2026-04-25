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
