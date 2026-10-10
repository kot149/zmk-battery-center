use reqwest::header::USER_AGENT;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::future::Future;
use tauri::AppHandle;
use tokio::sync::OnceCell;

const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/kot149/zmk-battery-center/releases/latest";
static UPDATE_RESULT: OnceCell<Option<UpdateInfo>> = OnceCell::const_new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub release_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

fn newer_release(current: &Version, release: GithubRelease) -> Result<Option<UpdateInfo>, String> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    let latest = Version::parse(version).map_err(|error| error.to_string())?;

    Ok((latest > *current).then(|| UpdateInfo {
        version: latest.to_string(),
        release_url: release.html_url,
    }))
}

async fn fetch_update(current: &Version) -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let release = client
        .get(LATEST_RELEASE_URL)
        .header(USER_AGENT, "zmk-battery-center")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?
        .json::<GithubRelease>()
        .await
        .map_err(|error| error.to_string())?;

    newer_release(current, release)
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    cached_update(&UPDATE_RESULT, || fetch_update(&app.package_info().version)).await
}

async fn cached_update<F, Fut>(
    cell: &OnceCell<Option<UpdateInfo>>,
    fetch: F,
) -> Result<Option<UpdateInfo>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Option<UpdateInfo>, String>>,
{
    cell.get_or_try_init(fetch).await.map(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::{cached_update, newer_release, GithubRelease, UpdateInfo};
    use semver::Version;
    use tokio::sync::OnceCell;

    #[tokio::test]
    async fn retries_after_failed_update_check() {
        let cell = OnceCell::new();
        assert!(
            cached_update(&cell, || async { Err("temporary failure".into()) })
                .await
                .is_err()
        );

        let update = UpdateInfo {
            version: "0.13.0".into(),
            release_url: "https://example.com/release".into(),
        };
        let result = cached_update(&cell, || async { Ok(Some(update)) })
            .await
            .unwrap();
        assert_eq!(result.unwrap().version, "0.13.0");
        assert!(cell.initialized());
    }

    #[test]
    fn compares_release_versions() {
        for (current, tag, expected) in [
            ("0.12.0", "v0.13.0", Some("0.13.0")),
            ("0.12.0", "v0.12.0", None),
            ("0.13.0", "v0.12.0", None),
            ("0.9.0", "v0.10.0", Some("0.10.0")),
        ] {
            let release = GithubRelease {
                tag_name: tag.into(),
                html_url: format!(
                    "https://github.com/kot149/zmk-battery-center/releases/tag/{tag}"
                ),
            };
            let result = newer_release(&Version::parse(current).unwrap(), release).unwrap();
            assert_eq!(result.as_ref().map(|info| info.version.as_str()), expected);
            if let Some(info) = result {
                assert!(info.release_url.ends_with(tag));
            }
        }
    }
}
