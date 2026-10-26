use tauri::AppHandle;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub async fn send_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        send_linux_notification(&title, body.as_deref()).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut notification = app.notification().builder().title(title);
        if let Some(body) = body {
            notification = notification.body(body);
        }
        notification.show().map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
async fn send_linux_notification(title: &str, body: Option<&str>) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).auto_icon();
    if let Some(body) = body {
        notification.body(body);
    }
    // Synchronous show() starts another Tokio runtime when ksni enables zbus/tokio.
    notification
        .show_async()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::send_linux_notification;

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn unavailable_bus_returns_error_without_runtime_panic() {
        const CHILD_ENV: &str = "ZMK_NOTIFICATION_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            let result = tokio::spawn(send_linux_notification("Test", Some("Body")))
                .await
                .expect("notification task must not panic");
            assert!(result.is_err(), "missing D-Bus socket must return an error");
            return;
        }

        // Isolate D-Bus configuration so tests never send a real desktop notification.
        let directory = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "notification::tests::unavailable_bus_returns_error_without_runtime_panic",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/missing-bus", directory.path().display()),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
