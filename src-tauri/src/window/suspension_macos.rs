use std::sync::atomic::Ordering;
use std::time::Duration;

use objc2_app_kit::{NSView, NSWindow};
use objc2_foundation::NSProcessInfo;
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{should_suspend, WindowState};

fn supported() -> bool {
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 14
}

pub(super) fn schedule(app: &AppHandle) {
    if !supported() {
        return;
    }
    let state = app.state::<WindowState>();
    if !state.ready.load(Ordering::SeqCst) {
        return;
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let app = app.clone();
    // Let pending IPC writes finish before stopping JavaScript timers.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let state = handle.state::<WindowState>();
            if !should_suspend(
                generation,
                state.generation.load(Ordering::SeqCst),
                state.requested_visible.load(Ordering::SeqCst),
                state.ready.load(Ordering::SeqCst),
            ) || state.detached_webview.load(Ordering::SeqCst) != 0
            {
                return;
            }
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            if let Err(error) = window.with_webview(move |webview| {
                let state = handle.state::<WindowState>();
                if !should_suspend(
                    generation,
                    state.generation.load(Ordering::SeqCst),
                    state.requested_visible.load(Ordering::SeqCst),
                    state.ready.load(Ordering::SeqCst),
                ) {
                    return;
                }
                // Wry retains the WKWebView while it is outside the window hierarchy.
                let view = unsafe { &*webview.inner().cast::<NSView>() };
                if unsafe { view.superview() }.is_some() {
                    state
                        .detached_ns_window
                        .store(webview.ns_window() as usize, Ordering::SeqCst);
                    view.removeFromSuperview();
                    state
                        .detached_webview
                        .store(webview.inner() as usize, Ordering::SeqCst);
                    log::debug!("Detached hidden main WebView");
                }
            }) {
                log::warn!("Failed to schedule main WebView detachment: {error}");
            }
        }) {
            log::warn!("Failed to run main WebView detachment: {error}");
        }
    });
}

pub(super) fn resume(window: &WebviewWindow) -> tauri::Result<()> {
    if !supported() {
        return Ok(());
    }
    let state = window.app_handle().state::<WindowState>();
    let detached = state.detached_webview.load(Ordering::SeqCst);
    if detached == 0 {
        return Ok(());
    }
    // Wry's with_webview requires an attached WKWebView, so restore it directly.
    let native_window = state.detached_ns_window.load(Ordering::SeqCst);
    if native_window == 0 {
        return Err(std::io::Error::other("Main WebView has no saved window").into());
    }
    let native_window = unsafe { &*(native_window as *const NSWindow) };
    let parent = native_window.contentView().ok_or_else(|| {
        std::io::Error::other("Main window has no content view for WebView attachment")
    })?;
    let view = unsafe { &*(detached as *const NSView) };
    if unsafe { view.superview() }.is_none() {
        view.setFrame(parent.bounds());
        parent.addSubview(view);
        native_window.makeFirstResponder(Some(view));
        log::debug!("Reattached main WebView");
    }
    state.detached_webview.store(0, Ordering::SeqCst);
    state.detached_ns_window.store(0, Ordering::SeqCst);
    Ok(())
}
