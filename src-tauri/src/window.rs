#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_positioner::{Position, WindowExt};
#[cfg(target_os = "windows")]
use windows::UI::ViewManagement::UISettings;

#[cfg(target_os = "windows")]
mod suspension;
#[cfg(target_os = "macos")]
mod suspension_macos;

#[derive(Default)]
pub struct WindowState {
    requested_visible: AtomicBool,
    ready: AtomicBool,
    generation: AtomicU64,
    #[cfg(target_os = "macos")]
    detached_webview: AtomicUsize,
    #[cfg(target_os = "macos")]
    detached_ns_window: AtomicUsize,
    pub tray_position_known: AtomicBool,
}

fn position_main_window(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let config = crate::monitor::current_config(app);
    if config["manualWindowPositioning"].as_bool().unwrap_or(false) {
        let x = config["windowPosition"]["x"].as_f64().unwrap_or(0.0);
        let y = config["windowPosition"]["y"].as_f64().unwrap_or(0.0);
        #[cfg(target_os = "macos")]
        window.set_position(tauri::LogicalPosition::new(x, y))?;
        #[cfg(not(target_os = "macos"))]
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
    } else if app
        .state::<WindowState>()
        .tray_position_known
        .load(Ordering::Relaxed)
    {
        window.move_window(Position::TrayCenter)?;
    } else {
        window.center()?;
    }
    Ok(())
}

pub fn main_window_requested(app: &AppHandle) -> bool {
    app.state::<WindowState>()
        .requested_visible
        .load(Ordering::SeqCst)
}

fn reveal_main_window(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    suspension::resume(window);
    let config = crate::monitor::current_config(app);
    if let Err(error) = window.set_always_on_top(config["pinWindow"].as_bool().unwrap_or(false)) {
        log::warn!("Failed to set main window pin state: {error}");
    }
    if let Err(error) = position_main_window(app, window) {
        log::warn!("Failed to position main window: {error}");
    }
    #[cfg(target_os = "macos")]
    suspension_macos::resume(window)?;
    window.show()?;
    if let Err(error) = window.set_focus() {
        log::warn!("Failed to focus main window: {error}");
    }
    let _ = app.emit_to("main", "main-window-shown", ());
    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = handle.state::<WindowState>();
        state.generation.fetch_add(1, Ordering::SeqCst);
        state.requested_visible.store(true, Ordering::SeqCst);
        if let Some(window) = handle.get_webview_window("main") {
            if state.ready.load(Ordering::SeqCst) {
                if let Err(error) = reveal_main_window(&handle, &window) {
                    log::error!("Failed to show main window: {error}");
                }
            }
            return;
        }
        state.ready.store(false, Ordering::SeqCst);
        let result = WebviewWindowBuilder::from_config(&handle, &handle.config().app.windows[0])
            .and_then(|builder| {
                let builder = if let Some(snapshot) = crate::monitor::current_snapshot() {
                    builder.initialization_script(format!(
                        "window.__INITIAL_MONITOR_STATE__ = {};",
                        serde_json::to_string(&snapshot)?
                    ))
                } else {
                    builder
                };
                #[cfg(target_os = "macos")]
                let builder = builder.background_throttling(
                    tauri::utils::config::BackgroundThrottlingPolicy::Suspend,
                );
                builder.visible(false).build()
            });
        if let Err(error) = result {
            state.requested_visible.store(false, Ordering::SeqCst);
            log::error!("Failed to create main window: {error}");
        }
    }) {
        log::error!("Failed to schedule main window creation: {error}");
    }
}

pub fn hide_main_window(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            if let Err(error) = window.hide() {
                log::error!("Failed to hide main window: {error}");
                return;
            }
        }
        let state = handle.state::<WindowState>();
        state.requested_visible.store(false, Ordering::SeqCst);
        state.generation.fetch_add(1, Ordering::SeqCst);
        #[cfg(target_os = "windows")]
        suspension::schedule(&handle);
        #[cfg(target_os = "macos")]
        suspension_macos::schedule(&handle);
    }) {
        log::error!("Failed to schedule main window dismissal: {error}");
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn should_suspend(
    scheduled_generation: u64,
    current_generation: u64,
    visible: bool,
    ready: bool,
) -> bool {
    scheduled_generation == current_generation && !visible && ready
}

pub fn on_main_destroyed(app: &AppHandle) {
    let state = app.state::<WindowState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.ready.store(false, Ordering::SeqCst);
    state.requested_visible.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    state.detached_webview.store(0, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    state.detached_ns_window.store(0, Ordering::SeqCst);
}

pub fn toggle_main_window(app: &AppHandle) {
    if main_window_requested(app) {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

pub fn refresh_main_window(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let state = handle.state::<WindowState>();
            state.generation.fetch_add(1, Ordering::SeqCst);
            state.requested_visible.store(true, Ordering::SeqCst);
            #[cfg(target_os = "windows")]
            suspension::resume(&window);
            #[cfg(target_os = "macos")]
            if let Err(error) = suspension_macos::resume(&window) {
                log::error!("Failed to attach main WebView before reload: {error}");
                return;
            }
            let was_ready = state.ready.swap(false, Ordering::SeqCst);
            if let Err(error) = window.reload() {
                state.ready.store(was_ready, Ordering::SeqCst);
                log::warn!("Failed to reload main window: {error}");
            }
        }
        show_main_window(&handle);
    }) {
        log::error!("Failed to schedule main window reload: {error}");
    }
}

pub fn show_about_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let result = if let Some(window) = handle.get_webview_window("about") {
            Ok(window)
        } else {
            WebviewWindowBuilder::new(
                &handle,
                "about",
                tauri::WebviewUrl::App("about.html".into()),
            )
            .title("zmk-battery-center - About")
            .inner_size(600.0, 500.0)
            .center()
            .build()
        };
        match result {
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(error) => log::error!("Failed to open About window: {error}"),
        }
    });
}

#[tauri::command]
pub async fn dismiss_main_window(app: AppHandle) {
    hide_main_window(&app);
}

#[tauri::command]
pub async fn window_ready(
    app: AppHandle,
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let handle = app.clone();
    let (reply, result) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let state = handle.state::<WindowState>();
        if let Err(error) = resize_main_window(&window, width, height) {
            log::warn!("Failed to size main window: {error}");
        }
        state.ready.store(true, Ordering::SeqCst);
        let revealed = if state.requested_visible.load(Ordering::SeqCst) {
            reveal_main_window(&handle, &window).map_err(|error| error.to_string())
        } else {
            #[cfg(target_os = "windows")]
            suspension::schedule(&handle);
            #[cfg(target_os = "macos")]
            suspension_macos::schedule(&handle);
            Ok(())
        };
        let _ = reply.send(revealed);
    })
    .map_err(|error| error.to_string())?;
    result.await.map_err(|error| error.to_string())?
}

fn resize_main_window(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let size = content_size(
        width,
        height,
        get_windows_text_scale_factor(),
        cfg!(target_os = "linux"),
    )?;
    window.set_size(size).map_err(|error| error.to_string())
}

fn content_size(
    width: f64,
    height: f64,
    scale: f64,
    linux: bool,
) -> Result<tauri::LogicalSize<f64>, String> {
    if [width, height, scale]
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err("Content dimensions and scale must be positive and finite".into());
    }
    // GTK client-side decorations add a shadow margin outside the content.
    let width = width * scale + if linux { 16.0 } else { 0.0 };
    let height = height * scale + if linux { 8.0 } else { 0.0 };
    Ok(tauri::LogicalSize::new(width, height))
}

#[tauri::command]
pub async fn position_main_window_at_tray(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    if window.label() == "main" {
        position_main_window(&app, &window).map_err(|error| error.to_string())?;
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::{content_size, should_suspend};

    #[test]
    fn suspends_only_the_current_ready_hidden_window() {
        assert!(should_suspend(1, 1, false, true));
        assert!(!should_suspend(1, 2, false, true));
        assert!(!should_suspend(1, 1, true, true));
        assert!(!should_suspend(1, 2, true, true));
        assert!(!should_suspend(1, 1, false, false));
    }

    #[test]
    fn scales_content_and_preserves_linux_shadow_margins() {
        assert_eq!(
            content_size(360.0, 200.0, 1.25, false).unwrap(),
            tauri::LogicalSize::new(450.0, 250.0)
        );
        assert_eq!(
            content_size(360.0, 200.0, 1.0, true).unwrap(),
            tauri::LogicalSize::new(376.0, 208.0)
        );
    }

    #[test]
    fn rejects_invalid_content_dimensions() {
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(content_size(invalid, 200.0, 1.0, false).is_err());
            assert!(content_size(360.0, invalid, 1.0, false).is_err());
            assert!(content_size(360.0, 200.0, invalid, false).is_err());
        }
    }
}
