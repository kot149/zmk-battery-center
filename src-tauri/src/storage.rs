#[cfg(debug_assertions)]
const DEV_DATA_DIR: &str = ".dev-data";
#[cfg(debug_assertions)]
const DATA_DIR_ENV: &str = "ZMK_BATTERY_CENTER_DATA_DIR";

#[cfg(debug_assertions)]
fn resolve_dev_store_path(manifest_dir: Option<&str>, env_dir: Option<&str>) -> Option<String> {
    use std::path::PathBuf;

    let manifest_dir = manifest_dir?;
    let manifest_path = PathBuf::from(manifest_dir);
    let project_root = manifest_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| manifest_path.clone());

    let dev_data = if let Some(dir) = env_dir {
        let path = PathBuf::from(dir);
        if path.is_absolute() {
            path
        } else {
            project_root.join(dir)
        }
    } else {
        project_root.join(DEV_DATA_DIR)
    };

    Some(dev_data.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_dev_store_path() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok();
        let env_dir = std::env::var(DATA_DIR_ENV).ok();
        resolve_dev_store_path(manifest_dir.as_deref(), env_dir.as_deref())
    }

    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    #[cfg(debug_assertions)]
    use super::resolve_dev_store_path;
    #[cfg(debug_assertions)]
    use std::path::PathBuf;

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_store_path_uses_absolute_env_path() {
        let path = resolve_dev_store_path(Some("/repo/src-tauri"), Some("/tmp/custom-dev-data"))
            .map(PathBuf::from);
        let expected = PathBuf::from("/tmp/custom-dev-data");
        assert_eq!(path, Some(expected));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_store_path_uses_relative_env_under_project_root() {
        let path = resolve_dev_store_path(Some("/repo/src-tauri"), Some("custom-dev-data"))
            .map(PathBuf::from);
        let expected = PathBuf::from("/repo").join("custom-dev-data");
        assert_eq!(path, Some(expected));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_store_path_falls_back_to_default_dir() {
        let path = resolve_dev_store_path(Some("/repo/src-tauri"), None).map(PathBuf::from);
        let expected = PathBuf::from("/repo").join(".dev-data");
        assert_eq!(path, Some(expected));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_store_path_returns_none_without_manifest_dir() {
        let path = resolve_dev_store_path(None, Some("custom-dev-data"));
        assert_eq!(path, None);
    }
}
