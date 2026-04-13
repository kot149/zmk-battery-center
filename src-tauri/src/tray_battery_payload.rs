use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayBatteryPayload {
    pub enabled: bool,
    pub central_percent: Option<u8>,
    pub peripheral_percent: Option<u8>,
    pub central_label: Option<String>,
    pub peripheral_label: Option<String>,
    pub disconnected: bool,
}
