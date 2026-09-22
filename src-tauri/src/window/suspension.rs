use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::{Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler};
use windows_core::Interface;

use super::{should_suspend, WindowState};

pub(super) fn schedule(app: &AppHandle) {
    let state = app.state::<WindowState>();
    if !state.ready.load(Ordering::SeqCst) {
        return;
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let app = app.clone();
    // Let pending IPC writes finish before stopping JavaScript timers.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Err(error) = window.with_webview(move |webview| {
            let state = app.state::<WindowState>();
            if !should_suspend(
                generation,
                state.generation.load(Ordering::SeqCst),
                state.requested_visible.load(Ordering::SeqCst),
                state.ready.load(Ordering::SeqCst),
            ) {
                return;
            }
            let result = (|| -> windows_core::Result<()> {
                let controller = webview.controller();
                // Hiding the native parent does not set the controller's visibility.
                unsafe { controller.SetIsVisible(false)? };
                let core: ICoreWebView2_3 = unsafe { controller.CoreWebView2()? }.cast()?;
                let completed =
                    TrySuspendCompletedHandler::create(Box::new(move |result, suspended| {
                        let state = app.state::<WindowState>();
                        let visible = state.requested_visible.load(Ordering::SeqCst);
                        let ready = state.ready.load(Ordering::SeqCst);
                        let current_generation = state.generation.load(Ordering::SeqCst);
                        if current_generation != generation || visible || !ready {
                            if visible && ready {
                                // A show request can overtake the asynchronous suspension.
                                if let Some(window) = app.get_webview_window("main") {
                                    resume_for_generation(&window, Some(current_generation));
                                }
                            }
                            return Ok(());
                        }
                        if let Err(error) = result {
                            log::warn!("Failed to suspend main WebView: {error}");
                        } else if suspended {
                            log::debug!("Suspended hidden main WebView");
                        } else {
                            log::debug!("Main WebView declined suspension");
                        }
                        Ok(())
                    }));
                unsafe { core.TrySuspend(&completed) }
            })();
            if let Err(error) = result {
                log::warn!("Failed to suspend main WebView: {error}");
            }
        }) {
            log::warn!("Failed to schedule main WebView suspension: {error}");
        }
    });
}

pub(super) fn resume(window: &WebviewWindow) {
    resume_for_generation(window, None);
}

fn resume_for_generation(window: &WebviewWindow, expected_generation: Option<u64>) {
    let app = window.app_handle().clone();
    if let Err(error) = window.with_webview(move |webview| {
        let state = app.state::<WindowState>();
        if !state.requested_visible.load(Ordering::SeqCst)
            || expected_generation.is_some_and(|generation| {
                generation != state.generation.load(Ordering::SeqCst)
                    || !state.ready.load(Ordering::SeqCst)
            })
        {
            return;
        }
        let controller = webview.controller();
        let result = (|| -> windows_core::Result<()> {
            let core: ICoreWebView2_3 = unsafe { controller.CoreWebView2()? }.cast()?;
            unsafe { core.Resume() }
        })();
        if let Err(error) = result {
            log::warn!("Failed to resume main WebView: {error}");
        }
        if let Err(error) = unsafe { controller.SetIsVisible(true) } {
            log::warn!("Failed to show main WebView controller: {error}");
        }
    }) {
        log::warn!("Failed to schedule main WebView resume: {error}");
    }
}
