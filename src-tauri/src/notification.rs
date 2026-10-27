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
    let handle = notification
        .show_async()
        .await
        .map_err(|error| error.to_string())?;
    // GNOME removes notifications when their sender's D-Bus connection disappears.
    tauri::async_runtime::spawn(async move {
        handle.wait_for_action_async(|_| {}).await;
    });
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::send_linux_notification;
    use std::collections::HashMap;
    use std::time::Duration;

    struct Notifications {
        sender: Option<tokio::sync::oneshot::Sender<String>>,
    }

    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl Notifications {
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &mut self,
            _app_name: &str,
            _replaces_id: u32,
            _app_icon: &str,
            summary: &str,
            body: &str,
            _actions: Vec<String>,
            _hints: HashMap<String, zbus::OwnedVariant>,
            _expire_timeout: i32,
            #[zbus(header)] header: zbus::message::Header<'_>,
        ) -> u32 {
            assert_eq!(summary, "Test");
            assert_eq!(body, "Body");
            self.sender
                .take()
                .unwrap()
                .send(header.sender().unwrap().to_string())
                .unwrap();
            1
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn successful_notification_keeps_connection_until_closed() {
        const CHILD_ENV: &str = "ZMK_NOTIFICATION_LIFETIME_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let output = std::process::Command::new("dbus-run-session")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "notification::tests::successful_notification_keeps_connection_until_closed",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .output()
                .expect("dbus-run-session is required for the notification lifetime test");
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        tokio::time::timeout(Duration::from_secs(5), async {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let service = zbus::connection::Builder::session()
                .name("org.freedesktop.Notifications")
                .serve_at(
                    "/org/freedesktop/Notifications",
                    Notifications { sender: Some(tx) },
                )
                .build()
                .await
                .unwrap();
            let bus = zbus::fdo::DBusProxy::new(&service).await.unwrap();

            send_linux_notification("Test", Some("Body")).await.unwrap();
            let sender = rx.await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(
                bus.name_has_owner(sender.as_str().try_into().unwrap())
                    .await
                    .unwrap(),
                "notification connection must survive the send call"
            );

            // Repeat until the close listener is registered and releases the connection.
            while bus
                .name_has_owner(sender.as_str().try_into().unwrap())
                .await
                .unwrap()
            {
                service
                    .emit_signal(
                        None::<&str>,
                        "/org/freedesktop/Notifications",
                        "org.freedesktop.Notifications",
                        "NotificationClosed",
                        &(1_u32, 2_u32),
                    )
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notification must return promptly and release its connection after closing");
    }

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
