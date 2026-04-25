//! AppKit-native tray content: `NSView` subclass (`drawRect:`) behind TaoTrayTarget,
//! using `NSBezierPath` and `NSString` drawing (no generated tray bitmap).

use crate::tray_battery_payload::{TrayBatteryPayload, TrayIconComponent};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{define_class, msg_send, AnyThread, ClassType, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBezierPath, NSColor, NSCompositingOperation, NSFont, NSFontAttributeName,
    NSFontDescriptorSystemDesignRounded, NSFontWeightSemibold, NSForegroundColorAttributeName,
    NSImage, NSStatusBarButton, NSStringDrawing, NSView, NSWindowOrderingMode,
};
use objc2_core_foundation::{CGFloat, CGPoint};
use objc2_foundation::NSObjectProtocol;
use objc2_foundation::{
    MainThreadMarker, NSAttributedStringKey, NSDictionary, NSPoint, NSRect, NSSize, NSString,
};
use std::cell::RefCell;
use std::ffi::CStr;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Default)]
struct DrawState {
    enabled: bool,
    components: Vec<TrayIconComponent>,
    row_count: u8,
    central: Option<u8>,
    peripheral: Option<u8>,
    c_label: char,
    p_label: char,
    disconnected: bool,
}

impl DrawState {
    fn sync_from_payload(&mut self, p: &TrayBatteryPayload) {
        self.enabled = p.enabled;
        self.components = if p.components.is_empty() {
            vec![TrayIconComponent::RoleLabel]
        } else {
            p.components.clone()
        };
        self.row_count = p.row_count.clamp(1, 2);
        self.central = p.central_percent;
        self.peripheral = p.peripheral_percent;
        self.c_label = one_char(&p.central_label, 'C');
        self.p_label = one_char(&p.peripheral_label, 'P');
        self.disconnected = p.disconnected;
    }

    fn has_component(&self, component: TrayIconComponent) -> bool {
        self.components.contains(&component)
    }
}

fn one_char(s: &Option<String>, d: char) -> char {
    s.as_ref()
        .and_then(|x| x.chars().next())
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .unwrap_or(d)
}

#[derive(Default)]
struct BatteryIvars {
    state: RefCell<DrawState>,
    app_icon: Option<Retained<NSImage>>,
}

fn label_text_color(muted: bool) -> Retained<NSColor> {
    if muted {
        NSColor::secondaryLabelColor()
    } else {
        NSColor::labelColor()
    }
}

fn attributed_attributes(
    font: Retained<NSFont>,
    color: Retained<NSColor>,
) -> Retained<NSDictionary<NSAttributedStringKey, AnyObject>> {
    unsafe {
        let font_obj: Retained<AnyObject> = Retained::cast_unchecked(font);
        let color_obj: Retained<AnyObject> = Retained::cast_unchecked(color);
        NSDictionary::from_retained_objects(
            &[NSFontAttributeName, NSForegroundColorAttributeName],
            &[font_obj, color_obj],
        )
    }
}

fn rounded_semibold_label_font(size: CGFloat) -> Retained<NSFont> {
    unsafe {
        let base = NSFont::systemFontOfSize_weight(size, NSFontWeightSemibold);
        let desc = base.fontDescriptor();
        match desc.fontDescriptorWithDesign(NSFontDescriptorSystemDesignRounded) {
            Some(rounded) => NSFont::fontWithDescriptor_size(&rounded, size).unwrap_or(base),
            None => base,
        }
    }
}

fn pct_string(v: Option<u8>) -> String {
    match v {
        Some(n) => format!("{}%", n.min(100)),
        None => "--".to_string(),
    }
}

fn digit_count(level: Option<u8>) -> usize {
    level
        .map(|n| {
            let n = n.min(100);
            if n >= 100 {
                3
            } else if n >= 10 {
                2
            } else {
                1
            }
        })
        .unwrap_or(2)
}

fn percent_placeholder_width(
    digits: usize,
    pct_attrs: &NSDictionary<NSAttributedStringKey, AnyObject>,
) -> CGFloat {
    let placeholder = format!("{:0width$}%", 0, width = digits.max(1));
    let ps = NSString::from_str(&placeholder);
    unsafe { ps.sizeWithAttributes(Some(pct_attrs)).width }
}

const PAD_X: CGFloat = 6.0;
const INNER_GAP: CGFloat = 2.5;
/// Tray content height (two rows); matches status item button height.
const ROW_TOTAL_H: CGFloat = 24.0;
const FONT_PT: CGFloat = 11.0;
const APP_ICON_W: CGFloat = 18.0;
const APP_ICON_H: CGFloat = 18.0;
const APP_ICON_Y_OFFSET: CGFloat = -1.0;
const APP_ICON_TRAILING_GAP: CGFloat = INNER_GAP + 2.0;
const ICON_W: CGFloat = 18.0;
const ICON_H: CGFloat = 8.0;
const BAT_LINE_W: CGFloat = 0.75;
const NUB_W: CGFloat = 1.5;
const MIN_VIEW_WIDTH: CGFloat = 18.0;

fn battery_icon_width() -> CGFloat {
    ICON_W
}

fn append_component_width(total: &mut CGFloat, component_count: &mut usize, width: CGFloat) {
    if *component_count > 0 {
        *total += INNER_GAP;
    }
    *total += width;
    *component_count += 1;
}

fn label_column_width(
    a: char,
    b: char,
    attrs: &NSDictionary<NSAttributedStringKey, AnyObject>,
) -> CGFloat {
    let s1 = NSString::from_str(&a.to_string());
    let s2 = NSString::from_str(&b.to_string());
    unsafe {
        let w1 = s1.sizeWithAttributes(Some(attrs)).width;
        let w2 = s2.sizeWithAttributes(Some(attrs)).width;
        w1.max(w2).max(12.0)
    }
}

fn label_column_width_single(
    label: char,
    attrs: &NSDictionary<NSAttributedStringKey, AnyObject>,
) -> CGFloat {
    let s = NSString::from_str(&label.to_string());
    unsafe { s.sizeWithAttributes(Some(attrs)).width.max(12.0) }
}

fn view_height_for_row_count(row_count: u8) -> CGFloat {
    if row_count <= 1 {
        ROW_TOTAL_H * 0.5
    } else {
        ROW_TOTAL_H
    }
}

fn content_width_for_state(state: &DrawState) -> CGFloat {
    let color = label_text_color(state.disconnected);
    let label_font = rounded_semibold_label_font(FONT_PT);
    let pct_font =
        unsafe { NSFont::monospacedDigitSystemFontOfSize_weight(FONT_PT, NSFontWeightSemibold) };
    let label_attrs = attributed_attributes(label_font.clone(), color.clone());
    let pct_attrs = attributed_attributes(pct_font.clone(), color.clone());
    let mut content_w = 0.0;
    let mut component_count = 0;
    if state.has_component(TrayIconComponent::AppIcon) {
        append_component_width(&mut content_w, &mut component_count, APP_ICON_W);
        if state.has_component(TrayIconComponent::RoleLabel)
            || state.has_component(TrayIconComponent::BatteryIcon)
            || state.has_component(TrayIconComponent::BatteryPercent)
        {
            content_w += APP_ICON_TRAILING_GAP - INNER_GAP;
        }
    }
    if state.has_component(TrayIconComponent::RoleLabel) {
        let label_col = if state.row_count <= 1 {
            label_column_width_single(state.c_label, &label_attrs)
        } else {
            label_column_width(state.c_label, state.p_label, &label_attrs)
        };
        append_component_width(&mut content_w, &mut component_count, label_col);
    }
    if state.has_component(TrayIconComponent::BatteryIcon) {
        append_component_width(&mut content_w, &mut component_count, battery_icon_width());
    }
    if state.has_component(TrayIconComponent::BatteryPercent) {
        let digits = if state.row_count <= 1 {
            digit_count(state.central)
        } else {
            digit_count(state.central).max(digit_count(state.peripheral))
        };
        append_component_width(
            &mut content_w,
            &mut component_count,
            percent_placeholder_width(digits, &pct_attrs),
        );
    }
    if component_count == 0 {
        0.0
    } else {
        PAD_X + content_w + PAD_X
    }
}

fn intrinsic_size_for_state(state: &DrawState) -> NSSize {
    if !state.enabled {
        return NSSize::new(0.0, ROW_TOTAL_H);
    }
    let w = content_width_for_state(state).max(MIN_VIEW_WIDTH);
    let h = view_height_for_row_count(state.row_count);
    NSSize::new(w, h)
}

fn measure_intrinsic(view: &BatteryTrayView) -> NSSize {
    intrinsic_size_for_state(&view.ivars().state.borrow())
}

fn draw_battery_icon(bat_x: CGFloat, icon_y: CGFloat, pct: Option<u8>, muted: bool) {
    let half = BAT_LINE_W * 0.5;
    let body_width = ICON_W - NUB_W;
    let body_height = ICON_H;
    let ink = {
        let base = label_text_color(muted);
        base.colorWithAlphaComponent(0.8)
    };
    ink.setStroke();
    let stroke_rect = NSRect::new(
        NSPoint::new(bat_x + half, icon_y + half),
        NSSize::new(body_width - BAT_LINE_W, body_height - BAT_LINE_W),
    );
    let body = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(stroke_rect, 2.0, 2.0);
    body.setLineWidth(BAT_LINE_W);
    body.stroke();
    if let Some(p) = pct {
        ink.setFill();
        let inset = BAT_LINE_W + 0.75;
        let fill_max_w = body_width - inset * 2.0;
        let fill_w = fill_max_w * (p.min(100) as CGFloat) / 100.0;
        let fill_h = body_height - inset * 2.0;
        let fill = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
            NSRect::new(
                NSPoint::new(bat_x + inset, icon_y + inset),
                NSSize::new(fill_w.max(0.0), fill_h.max(0.0)),
            ),
            0.75,
            0.75,
        );
        fill.fill();
    }
    let nub_h = body_height * 0.35;
    let nub_y = icon_y + (body_height - nub_h) * 0.5;
    let nub_x = bat_x + body_width;
    let nub = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
        NSRect::new(NSPoint::new(nub_x, nub_y), NSSize::new(NUB_W, nub_h)),
        0.5,
        0.5,
    );
    ink.setFill();
    nub.fill();
}

fn draw_app_icon(
    icon: Option<&NSImage>,
    icon_x: CGFloat,
    icon_y: CGFloat,
    muted: bool,
) {
    let Some(icon) = icon else {
        return;
    };
    let ink = label_text_color(muted);
    let rect = NSRect::new(
        NSPoint::new(icon_x, icon_y),
        NSSize::new(APP_ICON_W, APP_ICON_H),
    );
    ink.setFill();
    NSBezierPath::bezierPathWithRect(rect).fill();
    let src = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    unsafe {
        icon.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
            rect,
            src,
            NSCompositingOperation::DestinationIn,
            1.0,
            true,
            None,
        );
    }
}

struct BatteryRowLayout<'a> {
    x_start: CGFloat,
    row_h: CGFloat,
    label_col_w: Option<CGFloat>,
    pct_col_w: Option<CGFloat>,
    show_battery_icon: bool,
    label_attrs: &'a NSDictionary<NSAttributedStringKey, AnyObject>,
    pct_attrs: &'a NSDictionary<NSAttributedStringKey, AnyObject>,
    muted: bool,
}

fn draw_battery_row(layout: &BatteryRowLayout<'_>, y_top: CGFloat, label: char, pct: Option<u8>) {
    let mut x = layout.x_start;
    let mut drew_component = false;
    if let Some(label_col_w) = layout.label_col_w {
        let lstr = NSString::from_str(&label.to_string());
        let lsize = unsafe { lstr.sizeWithAttributes(Some(layout.label_attrs)) };
        let label_x = x + (label_col_w - lsize.width) * 0.5;
        let y_label = y_top + (layout.row_h - lsize.height) * 0.5;
        unsafe {
            lstr.drawAtPoint_withAttributes(
                CGPoint {
                    x: label_x,
                    y: y_label,
                },
                Some(layout.label_attrs),
            );
        }
        x += label_col_w;
        drew_component = true;
    }
    if layout.show_battery_icon {
        if drew_component {
            x += INNER_GAP;
        }
        let icon_y = y_top + (layout.row_h - ICON_H) * 0.5;
        draw_battery_icon(x, icon_y, pct, layout.muted);
        x += ICON_W;
        drew_component = true;
    }
    if let Some(pct_col_w) = layout.pct_col_w {
        if drew_component {
            x += INNER_GAP;
        }
        let pct_s = pct_string(pct);
        let pstr = NSString::from_str(&pct_s);
        let psize = unsafe { pstr.sizeWithAttributes(Some(layout.pct_attrs)) };
        let pct_draw_x = x + pct_col_w - psize.width;
        let y_pct = y_top + (layout.row_h - psize.height) * 0.5;
        unsafe {
            pstr.drawAtPoint_withAttributes(
                CGPoint {
                    x: pct_draw_x,
                    y: y_pct,
                },
                Some(layout.pct_attrs),
            );
        }
    }
}

fn draw_battery_content(view: &BatteryTrayView) {
    let bounds = view.bounds();
    NSColor::clearColor().set();
    let bg = NSBezierPath::bezierPathWithRect(bounds);
    bg.fill();
    let state = view.ivars().state.borrow();
    if !state.enabled {
        return;
    }
    let muted = state.disconnected;
    let color = label_text_color(muted);
    let label_font = rounded_semibold_label_font(FONT_PT);
    let pct_font =
        unsafe { NSFont::monospacedDigitSystemFontOfSize_weight(FONT_PT, NSFontWeightSemibold) };
    let label_attrs = attributed_attributes(label_font.clone(), color.clone());
    let pct_attrs = attributed_attributes(pct_font.clone(), color.clone());
    let rows = state.row_count.clamp(1, 2) as usize;
    let label_col = if state.has_component(TrayIconComponent::RoleLabel) {
        Some(if rows == 1 {
            label_column_width_single(state.c_label, &label_attrs)
        } else {
            label_column_width(state.c_label, state.p_label, &label_attrs)
        })
    } else {
        None
    };
    let pct_col = if state.has_component(TrayIconComponent::BatteryPercent) {
        let digits = if rows == 1 {
            digit_count(state.central)
        } else {
            digit_count(state.central).max(digit_count(state.peripheral))
        };
        Some(percent_placeholder_width(digits, &pct_attrs))
    } else {
        None
    };
    let (y_first, row_h) = if rows >= 2 {
        let block_h = ROW_TOTAL_H;
        let rh = block_h * 0.5;
        let y_off = ((bounds.size.height - block_h) * 0.5).max(0.0);
        (y_off, rh)
    } else {
        (0.0, bounds.size.height)
    };
    let mut row_x = PAD_X;
    if state.has_component(TrayIconComponent::AppIcon) {
        let icon_y = (bounds.size.height - APP_ICON_H) * 0.5 + APP_ICON_Y_OFFSET;
        draw_app_icon(view.ivars().app_icon.as_deref(), row_x, icon_y, muted);
        row_x += APP_ICON_W;
        if label_col.is_some()
            || state.has_component(TrayIconComponent::BatteryIcon)
            || pct_col.is_some()
        {
            row_x += APP_ICON_TRAILING_GAP;
        }
    }
    let row_layout = BatteryRowLayout {
        x_start: row_x,
        row_h,
        label_col_w: label_col,
        pct_col_w: pct_col,
        show_battery_icon: state.has_component(TrayIconComponent::BatteryIcon),
        label_attrs: &label_attrs,
        pct_attrs: &pct_attrs,
        muted,
    };
    draw_battery_row(&row_layout, y_first, state.c_label, state.central);
    if rows >= 2 {
        draw_battery_row(
            &row_layout,
            y_first + row_h,
            state.p_label,
            state.peripheral,
        );
    }
}

define_class!(
    #[unsafe(super(NSView))]
    #[name = "ZmkBatteryTrayContentView"]
    #[ivars = BatteryIvars]
    struct BatteryTrayView;

    impl BatteryTrayView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(intrinsicContentSize))]
        fn intrinsic_content_size_sel(&self) -> NSSize {
            measure_intrinsic(self)
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _rect: NSRect) {
            draw_battery_content(self);
        }
    }
);

impl BatteryTrayView {
    fn new(
        mtm: MainThreadMarker,
        payload: &TrayBatteryPayload,
        app_icon: Option<Retained<NSImage>>,
    ) -> Retained<Self> {
        let mut st = DrawState::default();
        st.sync_from_payload(payload);
        let size = intrinsic_size_for_state(&st);
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), size);
        let ptr = Self::alloc(mtm).set_ivars(BatteryIvars {
            state: RefCell::new(st),
            app_icon,
        });
        unsafe { msg_send![super(ptr), initWithFrame: frame] }
    }

    fn set_payload(&self, payload: &TrayBatteryPayload) {
        self.ivars().state.borrow_mut().sync_from_payload(payload);
        unsafe {
            self.setNeedsDisplay(true);
            let _: () = msg_send![self, invalidateIntrinsicContentSize];
        }
    }
}

fn find_subview_named(root: &NSView, name: &CStr) -> Option<Retained<NSView>> {
    let cls = AnyClass::get(name)?;
    let subs = root.subviews();
    let n = subs.count();
    for i in 0..n {
        let v = subs.objectAtIndex(i);
        if v.isKindOfClass(cls) {
            return Some(v);
        }
    }
    None
}

fn find_battery_view(button: &NSView) -> Option<Retained<BatteryTrayView>> {
    let cls = BatteryTrayView::class();
    let subs = button.subviews();
    let n = subs.count();
    for i in 0..n {
        let v = subs.objectAtIndex(i);
        if v.isKindOfClass(cls) {
            return v.downcast::<BatteryTrayView>().ok();
        }
    }
    None
}

fn remove_battery_overlay(button: &NSView) {
    if let Some(v) = find_battery_view(button) {
        unsafe {
            let _: () = msg_send![&*v, removeFromSuperview];
        }
    }
}

fn layout_overlay(button: &NSStatusBarButton, tray_target: &NSView, view: &BatteryTrayView) {
    let content = measure_intrinsic(view);
    let button_h = ROW_TOTAL_H;
    let content_y = ((button_h - content.height) * 0.5).max(0.0);
    view.setFrame(NSRect::new(
        NSPoint::new(0.0, content_y),
        NSSize::new(content.width, content.height),
    ));
    button.setFrameSize(NSSize::new(content.width, button_h));
    tray_target.setFrame(button.bounds());
    view.setNeedsDisplay(true);
}

fn restore_template_icon<R: Runtime>(app: &AppHandle<R>, tray: &TrayIcon<R>) -> Result<(), String> {
    use tauri::image::Image;
    let icon_path = app
        .path()
        .resolve(
            "icons/icon_template.png",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    let icon = Image::from_path(&icon_path).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    tray.set_icon_as_template(true).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_app_icon(icon_path: Option<&str>) -> Option<Retained<NSImage>> {
    let icon_path = icon_path?;
    let icon = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(icon_path))?;
    icon.setTemplate(true);
    Some(icon)
}

pub fn apply_tray_battery_state<R: Runtime>(
    app: &AppHandle<R>,
    tray: &TrayIcon<R>,
    payload: &TrayBatteryPayload,
) -> Result<(), String> {
    if !payload.enabled {
        match tray.with_inner_tray_icon(|inner| -> Result<(), String> {
            let mtm = MainThreadMarker::new().ok_or_else(|| "tray: not main thread".to_string())?;
            let item = inner
                .ns_status_item()
                .ok_or_else(|| "tray: no NSStatusItem".to_string())?;
            let button = item
                .button(mtm)
                .ok_or_else(|| "tray: no button".to_string())?;
            remove_battery_overlay(button.as_ref());
            button.setImage(None);
            Ok(())
        }) {
            Ok(Ok(())) => {}
            Ok(Err(s)) => return Err(s),
            Err(e) => return Err(e.to_string()),
        }
        return restore_template_icon(app, tray);
    }

    let payload = payload.clone();
    let app_icon_path = app
        .path()
        .resolve("icons/icon_template.png", tauri::path::BaseDirectory::Resource)
        .ok()
        .and_then(|path| path.to_str().map(ToOwned::to_owned));
    match tray.with_inner_tray_icon(move |inner| -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or_else(|| "tray: not main thread".to_string())?;
        let item = inner
            .ns_status_item()
            .ok_or_else(|| "tray: no NSStatusItem".to_string())?;
        let button = item
            .button(mtm)
            .ok_or_else(|| "tray: no button".to_string())?;
        let tray_target = find_subview_named(button.as_ref(), c"TaoTrayTarget")
            .ok_or_else(|| "tray: TaoTrayTarget missing".to_string())?;

        button.setImage(None);

        if let Some(existing) = find_battery_view(button.as_ref()) {
            existing.set_payload(&payload);
            layout_overlay(&button, tray_target.as_ref(), &existing);
        } else {
            let app_icon = load_app_icon(app_icon_path.as_deref());
            let view = BatteryTrayView::new(mtm, &payload, app_icon);
            button.addSubview_positioned_relativeTo(
                view.as_ref(),
                NSWindowOrderingMode::Below,
                Some(tray_target.as_ref()),
            );
            layout_overlay(&button, tray_target.as_ref(), &view);
        }
        Ok(())
    }) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(s)) => Err(s),
        Err(e) => Err(e.to_string()),
    }
}
