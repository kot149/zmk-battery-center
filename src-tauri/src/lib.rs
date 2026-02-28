use ansi_term::Color;
use tauri_plugin_autostart::MacosLauncher;

mod ble;
mod common;
mod history;
mod licenses;
mod storage;
mod tray;
mod window;

#[cfg(debug_assertions)] // for development
const LOG_LEVEL: log::LevelFilter = log::LevelFilter::Debug;

#[cfg(not(debug_assertions))] // for production
const LOG_LEVEL: log::LevelFilter = log::LevelFilter::Warn;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LOG_LEVEL)
                .format(|out, message, record| {
                    let level = record.level();
                    let level_str = level.to_string();

                    let colored_level_style = match level {
                        log::Level::Error => Color::Red.bold(),
                        log::Level::Warn => Color::Yellow.normal(),
                        log::Level::Info => Color::Green.normal(),
                        log::Level::Debug => Color::Blue.normal(),
                        log::Level::Trace => Color::Purple.normal(),
                    };

                    let colored_level = colored_level_style.paint(&level_str);
                    let bracket_left = colored_level_style.paint("[").to_string();
                    let bracket_right = colored_level_style.paint("]").to_string();

                    out.finish(format_args!(
                        "{left_bracket}{level}{right_bracket} {message}",
                        left_bracket = bracket_left,
                        level = colored_level,
                        right_bracket = bracket_right,
                        message = message
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
        .invoke_handler(tauri::generate_handler![
            common::exit_app,
            ble::list_battery_devices,
            ble::get_battery_info,
            ble::start_battery_notification_monitor,
            ble::stop_battery_notification_monitor,
            ble::stop_all_battery_monitors,
            window::get_windows_text_scale_factor,
            licenses::get_licenses,
            storage::get_dev_store_path,
            history::append_battery_history,
            history::read_battery_history,
        ])
        .setup(|app| {
            tray::init_tray(app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
