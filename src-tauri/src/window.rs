#[cfg(target_os = "windows")]
use windows::UI::ViewManagement::UISettings;

#[tauri::command]
pub fn get_windows_text_scale_factor() -> f64 {
    #[cfg(target_os = "windows")]
    {
        match UISettings::new() {
            Ok(settings) => match settings.TextScaleFactor() {
                Ok(factor) => {
                    log::debug!("Text scale factor: {}", factor);
                    factor
                }
                Err(e) => {
                    log::error!("Failed to get TextScaleFactor: {:?}. Using default 1.0", e);
                    1.0
                }
            },
            Err(e) => {
                log::error!("Failed to create UISettings: {:?}. Using default 1.0", e);
                1.0
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        log::info!("Non-Windows OS detected. Using default text scale factor 1.0");
        1.0
    }
}
