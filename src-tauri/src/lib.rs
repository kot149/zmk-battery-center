use owo_colors::OwoColorize;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

mod ble;
mod common;
mod external_integration;
mod history;
mod licenses;
mod monitor;
mod storage;
mod tray;
mod tray_battery_payload;
#[cfg(target_os = "macos")]
mod tray_native_macos;
mod update;
mod window;

#[cfg(debug_assertions)] // for development
const LOG_LEVEL: log::LevelFilter = log::LevelFilter::Debug;

#[cfg(not(debug_assertions))] // for production
const LOG_LEVEL: log::LevelFilter = log::LevelFilter::Warn;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Force GTK to use the X11 backend only under a Wayland session, where
        // absolute window coordinates cannot be queried for the manual window
        // positioning feature. Native X11 sessions already provide coordinates,
        // and forcing X11 on a Wayland-only system (no XWayland) prevents the
        // GTK window from starting at all. Must run before any GTK init.
        if std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
        {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LOG_LEVEL)
                .format(|out, message, record| {
                    let paint = |s: &str| -> String {
                        match record.level() {
                            log::Level::Error => s.red().bold().to_string(),
                            log::Level::Warn => s.yellow().to_string(),
                            log::Level::Info => s.green().to_string(),
                            log::Level::Debug => s.blue().to_string(),
                            log::Level::Trace => s.purple().to_string(),
                        }
                    };

                    out.finish(format_args!(
                        "{}{}{} {}",
                        paint("["),
                        paint(&record.level().to_string()),
                        paint("]"),
                        message
                    ))
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(external_integration::ExternalIntegrationState::default())
        .invoke_handler(tauri::generate_handler![
            common::exit_app,
            ble::list_battery_devices,
            ble::get_battery_info,
            ble::start_battery_notification_monitor,
            ble::stop_battery_notification_monitor,
            ble::stop_all_battery_monitors,
            external_integration::start_external_battery_source_session,
            external_integration::publish_external_battery_snapshot,
            window::get_windows_text_scale_factor,
            window::dismiss_main_window,
            window::window_ready,
            window::position_main_window_at_tray,
            monitor::get_monitor_state,
            monitor::monitor_update_config,
            monitor::monitor_is_update_dismissed,
            monitor::monitor_dismiss_update,
            monitor::monitor_add_device,
            monitor::monitor_remove_device,
            monitor::monitor_set_device_display_name,
            monitor::monitor_set_part_label,
            monitor::monitor_set_device_collapsed,
            monitor::monitor_reorder_devices,
            monitor::monitor_reload,
            licenses::get_licenses,
            storage::get_dev_store_path,
            history::append_battery_history,
            history::read_battery_history,
            tray::update_tray_battery_icon,
            tray::update_manual_positioning,
            tray::update_pin_window,
            update::check_for_update,
        ])
        .setup(|app| {
            app.manage(tray::TrayState {
                manual_positioning: std::sync::atomic::AtomicBool::new(false),
                pin_window: std::sync::atomic::AtomicBool::new(false),
                #[cfg(not(target_os = "linux"))]
                checks: std::sync::Mutex::new(None),
                #[cfg(target_os = "linux")]
                tray_handle: std::sync::Mutex::new(None),
            });

            app.manage(window::WindowState::default());
            monitor::initialize(app.handle()).map_err(std::io::Error::other)?;
            tray::init_tray(app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window::hide_main_window(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } => api.prevent_exit(),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => window::on_main_destroyed(app),
            _ => {}
        });
}
