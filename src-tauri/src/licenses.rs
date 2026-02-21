use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsLicense {
    pub name: String,
    pub version: String,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub publisher: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "licenseText")]
    pub license_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CargoLicense {
    pub name: String,
    pub version: String,
    pub license: Option<String>,
    pub authors: Option<Vec<String>>,
    pub repository: Option<String>,
    #[serde(rename = "licenseText")]
    pub license_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LicensesData {
    pub js_licenses: Vec<JsLicense>,
    pub cargo_licenses: Vec<CargoLicense>,
}

fn find_licenses_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Try resource dir first (for bundled app)
    if let Ok(resource_path) = app.path().resource_dir() {
        // Check direct path (bundled resources are flattened)
        let direct_js = resource_path.join("js-licenses.json");
        if direct_js.exists() {
            return Ok(resource_path);
        }

        // Check licenses subdirectory
        let licenses_dir = resource_path.join("licenses");
        if licenses_dir.join("js-licenses.json").exists() {
            return Ok(licenses_dir);
        }
    }

    // For development: try relative path from src-tauri
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("licenses"))
        .ok_or_else(|| "Failed to get parent directory".to_string())?;

    if dev_path.join("js-licenses.json").exists() {
        return Ok(dev_path);
    }

    Err(format!(
        "Could not find licenses directory. Tried resource_dir and dev path: {:?}",
        dev_path
    ))
}

#[tauri::command]
pub fn get_licenses(app: tauri::AppHandle) -> Result<LicensesData, String> {
    let licenses_dir = find_licenses_dir(&app)?;

    // Read JS licenses
    let js_licenses_path = licenses_dir.join("js-licenses.json");
    let js_licenses_content = std::fs::read_to_string(&js_licenses_path).map_err(|e| {
        format!(
            "Failed to read js-licenses.json from {:?}: {}",
            js_licenses_path, e
        )
    })?;
    let js_licenses: Vec<JsLicense> = serde_json::from_str(&js_licenses_content)
        .map_err(|e| format!("Failed to parse js-licenses.json: {}", e))?;

    // Read Cargo licenses
    let cargo_licenses_path = licenses_dir.join("cargo-licenses.json");
    let cargo_licenses_content = std::fs::read_to_string(&cargo_licenses_path).map_err(|e| {
        format!(
            "Failed to read cargo-licenses.json from {:?}: {}",
            cargo_licenses_path, e
        )
    })?;
    let cargo_licenses: Vec<CargoLicense> = serde_json::from_str(&cargo_licenses_content)
        .map_err(|e| format!("Failed to parse cargo-licenses.json: {}", e))?;

    let mut all_js_licenses = js_licenses;

    let manual_licenses_path = licenses_dir.join("manual-licenses.json");
    if manual_licenses_path.exists() {
        if let Ok(manual_content) = std::fs::read_to_string(&manual_licenses_path) {
            if let Ok(manual_licenses) = serde_json::from_str::<Vec<JsLicense>>(&manual_content)
            {
                all_js_licenses.extend(manual_licenses);
            }
        }
    }

    Ok(LicensesData {
        js_licenses: all_js_licenses,
        cargo_licenses,
    })
}
