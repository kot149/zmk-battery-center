use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_positioner::{Position, WindowExt};
#[cfg(target_os = "windows")]
use windows::UI::ViewManagement::UISettings;

#[derive(Default)]
pub struct WindowState {
    requested_visible: AtomicBool,
    ready: AtomicBool,
    closing: AtomicBool,
    generation: AtomicU64,
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

fn reveal_main_window(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let config = crate::monitor::current_config(app);
    if let Err(error) = window.set_always_on_top(config["pinWindow"].as_bool().unwrap_or(false)) {
        log::warn!("Failed to set main window pin state: {error}");
    }
    if let Err(error) = position_main_window(app, window) {
        log::warn!("Failed to position main window: {error}");
    }
    window.show()?;
    window.set_focus()
}

pub fn show_main_window(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = handle.state::<WindowState>();
        state.generation.fetch_add(1, Ordering::SeqCst);
        state.requested_visible.store(true, Ordering::SeqCst);
        if state.closing.load(Ordering::SeqCst) {
            return;
        }
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
            .and_then(|builder| builder.visible(false).build());
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
        let state = handle.state::<WindowState>();
        state.requested_visible.store(false, Ordering::SeqCst);
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(window) = handle.get_webview_window("main") {
            if let Err(error) = window.hide() {
                log::error!("Failed to hide main window: {error}");
                return;
            }
        }
        // Allow pending IPC writes to finish and quick tray clicks to reuse the view.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let state = app.state::<WindowState>();
                if should_release(
                    generation,
                    state.generation.load(Ordering::SeqCst),
                    state.requested_visible.load(Ordering::SeqCst),
                ) {
                    if let Some(window) = app.get_webview_window("main") {
                        state.closing.store(true, Ordering::SeqCst);
                        if let Err(error) = window.destroy() {
                            state.closing.store(false, Ordering::SeqCst);
                            log::warn!("Failed to release main WebView: {error}");
                        } else {
                            state.ready.store(false, Ordering::SeqCst);
                            log::debug!("Released hidden main WebView");
                        }
                    }
                }
            });
        });
    }) {
        log::error!("Failed to schedule main window dismissal: {error}");
    }
}

fn should_release(scheduled_generation: u64, current_generation: u64, visible: bool) -> bool {
    scheduled_generation == current_generation && !visible
}

pub fn on_main_destroyed(app: &AppHandle) {
    let state = app.state::<WindowState>();
    state.ready.store(false, Ordering::SeqCst);
    state.closing.store(false, Ordering::SeqCst);
    if state.requested_visible.load(Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            show_main_window(&app);
        });
    }
}

pub fn toggle_main_window(app: &AppHandle) {
    if app
        .state::<WindowState>()
        .requested_visible
        .load(Ordering::SeqCst)
    {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

pub fn refresh_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        app.state::<WindowState>()
            .ready
            .store(false, Ordering::SeqCst);
        if let Err(error) = window.reload() {
            log::warn!("Failed to reload main window: {error}");
        }
    }
    show_main_window(app);
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
pub async fn window_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let handle = app.clone();
    let (reply, result) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let state = handle.state::<WindowState>();
        if state.closing.load(Ordering::SeqCst) {
            let _ = reply.send(Err("Main window is closing".to_string()));
            return;
        }
        state.ready.store(true, Ordering::SeqCst);
        let revealed = if state.requested_visible.load(Ordering::SeqCst) {
            reveal_main_window(&handle, &window).map_err(|error| error.to_string())
        } else {
            Ok(())
        };
        let _ = reply.send(revealed);
    })
    .map_err(|error| error.to_string())?;
    result.await.map_err(|error| error.to_string())?
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
    use super::should_release;

    #[test]
    fn releases_only_the_current_hidden_window() {
        assert!(should_release(1, 1, false));
        assert!(!should_release(1, 2, false));
        assert!(!should_release(1, 1, true));
        assert!(!should_release(1, 2, true));
    }
}
