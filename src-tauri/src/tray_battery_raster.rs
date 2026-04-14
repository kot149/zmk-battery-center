//! Windows / Linux tray battery: square RGBA icon with text lines only (e.g. `C87%` / `P45%`).

use crate::tray_battery_payload::TrayBatteryPayload;
use tauri::{AppHandle, Manager, Runtime};
use tauri::image::Image;
use tauri::tray::TrayIcon;

/// Larger source bitmaps downscale more cleanly in the shell tray (within typical HICON limits).
const SIDE: u32 = 768;
const GLYPH_W: i32 = 5;
const GLYPH_H: i32 = 7;
/// No outer pad: metrics already reserve space for the faux-bold stroke.
const CANVAS_PAD: i32 = 0;

fn one_char(s: &Option<String>, d: char) -> char {
    s.as_ref()
        .and_then(|x| x.chars().next())
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .unwrap_or(d)
}

/// Opaque background: Windows `CreateIcon` AND-mask path mishandles per-pixel alpha from
/// `tray-icon`; keeping alpha 255 everywhere avoids corrupted transparency.
const BG_RGBA: [u8; 4] = [32, 32, 32, 255];
const INK_RGBA: [u8; 4] = [255, 255, 255, 255];

fn glyph_rows(ch: char) -> &'static [u8; 7] {
    match ch {
        ' ' => &[0, 0, 0, 0, 0, 0, 0],
        '0' => &[0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => &[0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => &[0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => &[0x0E, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0E],
        '4' => &[0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => &[0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => &[0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => &[0x1F, 0x01, 0x02, 0x04, 0x04, 0x04, 0x04],
        '8' => &[0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => &[0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '%' => &[0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
        '-' => &[0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        'C' => &[0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'P' => &[0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        _ => &[0x0E, 0x11, 0x01, 0x07, 0x01, 0x11, 0x0E],
    }
}

fn label_glyph_char(c: char) -> char {
    match c {
        ' ' => ' ',
        _ => {
            let u = c.to_ascii_uppercase();
            if u.is_ascii_digit() || matches!(u, '%' | '-' | 'C' | 'P') {
                u
            } else if u.is_ascii() && u != '\0' {
                u
            } else {
                '?'
            }
        }
    }
}

fn set_px(buf: &mut [u8], w: u32, h: u32, x: i32, y: i32, rgba: [u8; 4]) {
    if x < 0 || y < 0 {
        return;
    }
    let (x, y) = (x as u32, y as u32);
    if x >= w || y >= h {
        return;
    }
    let i = ((y * w + x) * 4) as usize;
    if i + 3 < buf.len() {
        buf[i..i + 4].copy_from_slice(&rgba);
    }
}

fn draw_glyph(
    buf: &mut [u8],
    w: u32,
    h: u32,
    x0: i32,
    y0: i32,
    rows: &[u8; 7],
    rgba: [u8; 4],
    scale: i32,
) {
    for (row, bits) in rows.iter().enumerate() {
        for col in 0..GLYPH_W {
            if (bits >> (GLYPH_W - 1 - col)) & 1 == 0 {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    set_px(
                        buf,
                        w,
                        h,
                        x0 + col * scale + dx,
                        y0 + row as i32 * scale + dy,
                        rgba,
                    );
                }
            }
        }
    }
}

fn glyph_advance(scale: i32) -> i32 {
    GLYPH_W * scale + 2
}

/// Width including faux-bold (+1 px) past the last glyph.
fn string_pixel_width(s: &str, scale: i32) -> i32 {
    s.chars().count() as i32 * glyph_advance(scale) + 1
}

fn line_gap(_scale: i32) -> i32 {
    2
}

fn max_scale_for_lines(lines: &[String], side: i32) -> i32 {
    let inner = side - CANVAS_PAD * 2;
    if inner < 8 || lines.is_empty() {
        return 1;
    }
    let max_chars = lines
        .iter()
        .map(|l| l.chars().count().max(1))
        .max()
        .unwrap_or(1) as i32;
    let n = lines.len() as i32;
    let mut best = 1;
    for scale in 1..=64 {
        let adv = glyph_advance(scale);
        let w = max_chars * adv + 1;
        let gap = line_gap(scale);
        let line_h = GLYPH_H * scale;
        let h = n * line_h + (n - 1).max(0) * gap;
        if w <= inner && h <= inner {
            best = scale;
        }
    }
    best
}

/// Slight stroke so small tray sizes stay readable after shell downscaling.
const BOLD_DX: [i32; 3] = [0, 1, 0];
const BOLD_DY: [i32; 3] = [0, 0, 1];

fn draw_string(
    buf: &mut [u8],
    cw: u32,
    buf_h: u32,
    mut x: i32,
    y: i32,
    s: &str,
    rgba: [u8; 4],
    scale: i32,
) {
    for c in s.chars() {
        let gc = label_glyph_char(c);
        let rows = glyph_rows(gc);
        for (&dx, &dy) in BOLD_DX.iter().zip(BOLD_DY.iter()) {
            draw_glyph(buf, cw, buf_h, x + dx, y + dy, rows, rgba, scale);
        }
        x += glyph_advance(scale);
    }
}

fn pct_string(v: Option<u8>) -> String {
    match v {
        Some(n) => format!("{}%", n.min(100)),
        None => "--".to_string(),
    }
}

fn status_line(label: char, pct: Option<u8>) -> String {
    format!("{}{}", label_glyph_char(label), pct_string(pct))
}

fn render_payload_rgba(payload: &TrayBatteryPayload) -> (u32, u32, Vec<u8>) {
    let ink = INK_RGBA;
    let bg = if payload.disconnected {
        [48, 48, 52, 255]
    } else {
        BG_RGBA
    };

    let rows = payload.row_count.clamp(1, 2) as usize;
    let c_label = one_char(&payload.central_label, 'C');
    let p_label = one_char(&payload.peripheral_label, 'P');

    let lines: Vec<String> = if rows >= 2 {
        vec![
            status_line(c_label, payload.central_percent),
            status_line(p_label, payload.peripheral_percent),
        ]
    } else {
        vec![status_line(c_label, payload.central_percent)]
    };

    let side_i = SIDE as i32;
    let scale = max_scale_for_lines(&lines, side_i);
    let line_h = GLYPH_H * scale;
    let gap = line_gap(scale);
    let block_h = lines.len() as i32 * line_h + (lines.len() as i32 - 1).max(0) * gap;

    let mut buf = vec![0u8; (SIDE * SIDE * 4) as usize];
    for px in buf.chunks_exact_mut(4) {
        px.copy_from_slice(&bg);
    }
    let start_y = (side_i - block_h) / 2;
    let mut y = start_y;
    for line in &lines {
        let lw = string_pixel_width(line, scale);
        let x = (side_i - lw) / 2;
        draw_string(&mut buf, SIDE, SIDE, x, y, line, ink, scale);
        y += line_h + gap;
    }

    (SIDE, SIDE, buf)
}

fn restore_default_tray_icon<R: Runtime>(app: &AppHandle<R>, tray: &TrayIcon<R>) -> Result<(), String> {
    let icon_path = app
        .path()
        .resolve("icons/32x32.png", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let icon = Image::from_path(&icon_path).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn apply_tray_battery_state<R: Runtime>(
    app: &AppHandle<R>,
    tray: &TrayIcon<R>,
    payload: &TrayBatteryPayload,
) -> Result<(), String> {
    if !payload.enabled {
        return restore_default_tray_icon(app, tray);
    }
    let (w, h, rgba) = render_payload_rgba(payload);
    let icon = Image::new_owned(rgba, w, h);
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    Ok(())
}
