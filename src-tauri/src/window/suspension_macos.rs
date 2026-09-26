use std::sync::atomic::Ordering;
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::{AnyObject, Bool};
use objc2::{msg_send, sel};
use tauri::{AppHandle, Manager, WebviewWindow};

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

            let view = webview.inner() as *mut AnyObject;
            // WKWebView's page suspension methods are available on macOS 12 and later.
            if !unsafe { msg_send![view, respondsToSelector: sel!(_suspendPage:)] } {
                return;
            }
            let completed = RcBlock::new(move |suspended: Bool| {
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
                    return;
                }
                if suspended.as_bool() {
                    log::debug!("Suspended hidden main WebView");
                } else {
                    log::debug!("Main WebView declined suspension");
                }
            });
            unsafe { msg_send![view, _suspendPage: &*completed] }
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

        let view = webview.inner() as *mut AnyObject;
        if !unsafe { msg_send![view, respondsToSelector: sel!(_resumePage:)] } {
            return;
        }
        let completed = RcBlock::new(|resumed: Bool| {
            if !resumed.as_bool() {
                log::debug!("Main WebView declined resume");
            }
        });
        unsafe { msg_send![view, _resumePage: &*completed] }
    }) {
        log::warn!("Failed to schedule main WebView resume: {error}");
    }
}
