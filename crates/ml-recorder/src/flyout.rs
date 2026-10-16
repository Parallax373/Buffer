//! The volume flyout of the audio tray icon (EarTrumpet's job, Buffer's look): every playback device as a card
//! with its master slider and the apps playing on it. A layered Win32 window on the tray thread, drawn into a
//! 32-bit DIB: shapes are anti-aliased in software, text and app icons go through GDI, the rounded outline gets its
//! alpha at the end and `UpdateLayeredWindow` shows it (which also does the slide-and-fade in and the fade out).
//! The mixer is read only while it is open (meters and volumes every frame, the device and app list once a
//! second); closed, nothing is polled.
//!
//! The module also owns a hidden window for the mouse wheel over the tray icon. Windows never sends wheel messages
//! to notification icons, so while the pointer rests on the icon a Raw Input sink (RIDEV_INPUTSINK, not a hook) is
//! registered, and dropped again when it leaves (EarTrumpet does the same).

use crate::{mixer, session};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GdiFlush, GetDC, GetDeviceCaps,
    GetMonitorInfoW, GetTextExtentPoint32W, MonitorFromPoint, ReleaseDC, ScreenToClient, SelectObject, SetBkMode, SetTextCharacterExtra, SetTextColor,
    AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, DIB_RGB_COLORS, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT,
    DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE, DT_VCENTER, HBITMAP, HDC, HFONT, LOGPIXELSX, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT, VK_ESCAPE};
use windows_sys::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RIDEV_REMOVE,
    RID_INPUT, RIM_TYPEMOUSE,
};
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DrawIconEx, GetCursorPos, KillTimer, LoadCursorW, RegisterClassW, SetCursor, SetForegroundWindow,
    SetTimer, SetWindowPos, ShowWindow, UpdateLayeredWindow, DI_NORMAL, HICON, HWND_TOPMOST, IDC_ARROW, IDC_HAND, RI_MOUSE_WHEEL,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, ULW_ALPHA, WA_INACTIVE, WM_ACTIVATE, WM_INPUT, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_SETCURSOR, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

const WM_MOUSELEAVE: u32 = 0x02a3;

/* ───────── geometry (logical px) ───────── */

const W: f64 = 372.0;
/// Outer padding and the corner radius of the window.
const PAD: f64 = 10.0;
const RADIUS: f64 = 12.0;
/// The brand row on top.
const TOP: f64 = 38.0;
const GAP: f64 = 8.0;
const LABEL: f64 = 30.0;
const MASTER: f64 = 44.0;
const APP: f64 = 38.0;
const CARD_BOTTOM: f64 = 6.0;
/// The "Open SoundSwitcher" button under the cards.
const FOOT: f64 = 36.0;
const SL_X0: f64 = PAD + 52.0;
const SL_X1: f64 = W - PAD - 60.0;
const NUM_RIGHT: f64 = W - PAD - 14.0;
/// Clicks left of this on a slider row toggle mute (the speaker glyph / the app icon).
const MUTE_X: f64 = PAD + 44.0;
const OPEN_MS: f64 = 190.0;
const CLOSE_MS: f64 = 110.0;

/* ───────── colours: the app's own tokens (ui/style.css) ───────── */

type Rgb = (u8, u8, u8);
const ACC: Rgb = (0xc6, 0xf4, 0x32);
const TEXT: Rgb = (0xee, 0xf0, 0xe6);
const MUTED: Rgb = (0x8e, 0x94, 0x84);
const SUBTLE: Rgb = (0x6f, 0x75, 0x66);
const BAD: Rgb = (0xff, 0x5d, 0x5d);

struct Theme {
    bg: Rgb,
    panel: Rgb,
    raised: Rgb,
    line: Rgb,
}

fn theme() -> Theme {
    match crate::overlay::theme() {
        // the olive-tinted neutrals of style.css's "now and trail" block (slate keeps its own blue ones)
        1 => Theme { bg: (0, 0, 0), panel: (0x0a, 0x0b, 0x08), raised: (0x14, 0x16, 0x0f), line: (0x20, 0x23, 0x1a) },
        2 => Theme { bg: (0x0f, 0x12, 0x18), panel: (0x15, 0x1a, 0x23), raised: (0x1d, 0x24, 0x30), line: (0x2a, 0x33, 0x42) },
        _ => Theme { bg: (0x0b, 0x0c, 0x0a), panel: (0x12, 0x14, 0x10), raised: (0x1a, 0x1d, 0x16), line: (0x26, 0x2a, 0x20) },
    }
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let f = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * t.clamp(0.0, 1.0)).round() as u8;
    (f(a.0, b.0), f(a.1, b.1), f(a.2, b.2))
}
/// GDI's COLORREF (0x00BBGGRR).
fn cref(c: Rgb) -> u32 {
    c.0 as u32 | (c.1 as u32) << 8 | (c.2 as u32) << 16
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

/* ───────── software canvas (BGRX pixels; alpha is set at the end) ───────── */

struct Canvas {
    px: *mut u32,
    w: i32,
    h: i32,
}

impl Canvas {
    fn blend(&mut self, x: i32, y: i32, c: Rgb, a: f64) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h || a <= 0.0 {
            return;
        }
        unsafe {
            let p = self.px.add((y * self.w + x) as usize);
            let n = if a >= 1.0 {
                c
            } else {
                let d = *p;
                mix(((d >> 16) as u8, (d >> 8) as u8, d as u8), c, a)
            };
            *p = (n.0 as u32) << 16 | (n.1 as u32) << 8 | n.2 as u32;
        }
    }

    /// Opaque fill: plain stores, no blending.
    fn fill(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, c: Rgb) {
        let v = (c.0 as u32) << 16 | (c.1 as u32) << 8 | c.2 as u32;
        let (xa, xb) = (x0.round().max(0.0) as i32, (x1.round() as i32).min(self.w));
        if xb <= xa {
            return;
        }
        for y in y0.round().max(0.0) as i32..(y1.round() as i32).min(self.h) {
            let row = unsafe { std::slice::from_raw_parts_mut(self.px.add((y * self.w + xa) as usize), (xb - xa) as usize) };
            row.fill(v);
        }
    }

    /// Anti-aliased rounded rectangle (signed distance per pixel centre); `a` scales its opacity.
    fn rrect_a(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, r: f64, c: Rgb, a: f64) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let r = r.min((x1 - x0) / 2.0).min((y1 - y0) / 2.0);
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let (hx, hy) = ((x1 - x0) / 2.0 - r, (y1 - y0) / 2.0 - r);
        for y in (y0.floor() as i32).max(0)..(y1.ceil() as i32).min(self.h) {
            for x in (x0.floor() as i32).max(0)..(x1.ceil() as i32).min(self.w) {
                let qx = ((x as f64 + 0.5 - cx).abs() - hx).max(0.0);
                let qy = ((y as f64 + 0.5 - cy).abs() - hy).max(0.0);
                let d = (qx * qx + qy * qy).sqrt() - r;
                // edges of a plain rectangle are covered by area, not by distance
                let cov = if r < 0.5 {
                    let ox = (x as f64 + 1.0).min(x1) - (x as f64).max(x0);
                    let oy = (y as f64 + 1.0).min(y1) - (y as f64).max(y0);
                    ox.clamp(0.0, 1.0) * oy.clamp(0.0, 1.0)
                } else {
                    (0.5 - d).clamp(0.0, 1.0)
                };
                self.blend(x, y, c, cov * a);
            }
        }
    }

    fn rrect(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, r: f64, c: Rgb) {
        self.rrect_a(x0, y0, x1, y1, r, c, 1.0);
    }

    fn disc(&mut self, cx: f64, cy: f64, r: f64, c: Rgb) {
        self.rrect(cx - r, cy - r, cx + r, cy + r, r, c);
    }
}

/* ───────── the speaker in the logo's scan-line style ───────── */

/// One bar of the speaker glyph on a 32-unit grid: x0, y0, x1, y1 and its part (0 = the speaker, n = wave n).
/// Seven 3-unit bars with 1-unit gaps, like the Buffer logo: the body and cone are the speaker, the three
/// columns to its right are the volume waves.
pub fn speaker_bars() -> Vec<(f64, f64, f64, f64, u8)> {
    let mut v = Vec::new();
    for i in 0..7 {
        let y0 = 2.0 + i as f64 * 4.0;
        let (x0, x1) = match i {
            0 | 6 => (12.0, 16.0),
            1 | 5 => (9.0, 16.0),
            _ => (3.0, 16.0),
        };
        v.push((x0, y0, x1, y0 + 3.0, 0));
        // waves: the nearer the louder, each one bar taller on both ends
        for (n, x, from) in [(1u8, 19.0, 2), (2, 23.5, 1), (3, 28.0, 0)] {
            if i >= from && i <= 6 - from {
                v.push((x, y0, x + 2.5, y0 + 3.0, n));
            }
        }
    }
    v
}

pub fn waves_for(v: f32) -> u8 {
    match v {
        v if v <= 0.0 => 0,
        v if v < 0.34 => 1,
        v if v < 0.67 => 2,
        _ => 3,
    }
}

/// Draws the speaker at (x, y) with `size` px for the 32-unit grid. Waves above the level fade like the logo's
/// tails; muted, the speaker greys out and the waves give way to a red cross.
fn draw_speaker(cv: &mut Canvas, x: f64, y: f64, size: f64, waves: u8, muted: bool) {
    let k = size / 32.0;
    let body = if muted { SUBTLE } else { ACC };
    for (x0, y0, x1, y1, part) in speaker_bars() {
        let (c, a) = match part {
            0 => (body, 1.0),
            _ if muted => continue,
            n if n <= waves => (ACC, 1.0),
            _ => (ACC, 0.25),
        };
        cv.rrect_a(x + x0 * k, y + y0 * k, x + x1 * k, y + y1 * k, 0.0, c, a);
    }
    if muted {
        // a 2-unit-thick X over where the waves were
        let (cx, cy) = (x + 25.0 * k, y + 16.0 * k);
        let steps = (14.0 * k).ceil() as i32 * 2;
        for i in 0..=steps {
            let t = -5.5 + 11.0 * i as f64 / steps as f64;
            cv.disc(cx + t * k, cy + t * k, 1.25 * k, BAD);
            cv.disc(cx + t * k, cy - t * k, 1.25 * k, BAD);
        }
    }
}

/* ───────── the app's "scan" bar and animated logo ───────── */

/// Segments of a scan bar between x0 and x1: (index, left, right). 2 px gaps, about 7 px per segment.
fn scan_segments(x0: f64, x1: f64, s: f64) -> Vec<(usize, f64, f64)> {
    let gap = 2.0 * s;
    let n = (((x1 - x0) + gap) / (9.0 * s)).round().max(4.0) as usize;
    let w = ((x1 - x0) - gap * (n - 1) as f64) / n as f64;
    (0..n).map(|k| (k, x0 + k as f64 * (w + gap), x0 + k as f64 * (w + gap) + w)).collect()
}

/// Opacity of a meter segment whose centre is at `f` (0..1): lit up to what plays now, brighter to the right
/// (the export bar's ramp), faint after it. The volume itself is the line above, not the scan.
fn scan_alpha(f: f64, level: f64) -> f64 {
    if f <= level {
        0.45 + 0.55 * f
    } else {
        0.08
    }
}

/// Width factor of logo bar `j` at `t` s after opening: style.css's barIn (0.26 s, staggered 45 ms from 120 ms)
/// and barRipple (1 -> 1.3 -> 1 over 4.4 s, staggered 385 ms from 500 ms).
fn logo_bar_scale(j: usize, t: f64) -> f64 {
    let grow = ease_out((t - 0.12 - 0.045 * j as f64) / 0.26);
    let rt = t - 0.5 - 0.385 * j as f64;
    let ripple = if rt > 0.0 { 1.0 + 0.3 * (0.5 - 0.5 * (rt / 4.4 * std::f64::consts::TAU).cos()) } else { 1.0 };
    grow * ripple
}

/* ───────── the flyout ───────── */

#[derive(Clone, PartialEq, Debug)]
enum Target {
    Dev(String),
    App(String, String),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// The brand row: the animated logo and the name, centred.
    Top,
    /// The "Open SoundSwitcher" button.
    Footer,
    Label(usize),
    Master(usize),
    App(usize, usize),
}

struct Row {
    kind: Kind,
    /// Top in content coordinates (logical px).
    y: f64,
    h: f64,
}

struct Fonts {
    brand: HFONT,
    label: HFONT,
    big: HFONT,
    num: HFONT,
    small: HFONT,
    button: HFONT,
    /// Widths (logical px) for centring: "Buffer" in `brand`, the open button's label in `button`.
    brand_w: f64,
    open_w: f64,
}

enum Anim {
    Opening(Instant),
    Open,
    Closing(Instant),
}

struct Flyout {
    hwnd: HWND,
    shared: Arc<session::Shared>,
    devs: Vec<mixer::Dev>,
    rows: Vec<Row>,
    /// Device cards: content top and bottom (logical px).
    cards: Vec<(f64, f64)>,
    s: f64,
    w: i32,
    h: i32,
    /// Where the window rests once the slide-in is over (screen px).
    pos: (i32, i32),
    /// Slide direction: +1 = it comes up from a bottom taskbar, -1 = down from a top one, 0 = sideways bar.
    dir: i32,
    scroll: f64,
    content: f64,
    mem: HDC,
    bmp: HBITMAP,
    px: *mut u32,
    fonts: Option<Fonts>,
    icons: HashMap<String, HICON>,
    drag: Option<Target>,
    hover: Option<usize>,
    hover_x: f64,
    tracking: bool,
    anim: Option<Anim>,
    /// When it opened: the logo's animation runs from here.
    t0: Instant,
    closed_at: Option<Instant>,
    frame: u32,
    wheel_rest: i32,
}

/// Debug builds: set by the `mix-flyout` control command, picked up by the tray thread.
pub static OPEN_REQUEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

thread_local! {
    static FLY: RefCell<Option<Flyout>> = const { RefCell::new(None) };
    static SINK: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
    static SINK_ON: Cell<bool> = const { Cell::new(false) };
    /// The audio tray icon's rectangle while the pointer is on it (screen coordinates).
    static ICON_RECT: Cell<Option<RECT>> = const { Cell::new(None) };
}

fn lo(lp: LPARAM) -> i32 {
    (lp & 0xffff) as i16 as i32
}
fn hi(lp: LPARAM) -> i32 {
    ((lp >> 16) & 0xffff) as i16 as i32
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // our own calls (show, hide, capture) send messages back synchronously: those find the state busy and fall through
    let r = FLY.with(|f| f.try_borrow_mut().ok().and_then(|mut g| g.as_mut().and_then(|fl| fl.on_msg(msg, wp, lp))));
    r.unwrap_or_else(|| DefWindowProcW(hwnd, msg, wp, lp))
}

unsafe extern "system" fn sink_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        let mut raw: RAWINPUT = std::mem::zeroed();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let got = GetRawInputData(lp as HRAWINPUT, RID_INPUT, &mut raw as *mut _ as *mut _, &mut size, std::mem::size_of::<RAWINPUTHEADER>() as u32);
        if got != u32::MAX && raw.header.dwType == RIM_TYPEMOUSE {
            let b = raw.data.mouse.Anonymous.Anonymous;
            if b.usButtonFlags as u32 & RI_MOUSE_WHEEL != 0 {
                let delta = b.usButtonData as i16 as i32;
                let mut p = POINT { x: 0, y: 0 };
                GetCursorPos(&mut p);
                let over = ICON_RECT.with(|r| r.get()).is_some_and(|r| p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom);
                if over {
                    crate::tray::on_wheel(delta);
                }
            }
        }
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

/// Creates the (hidden) flyout and wheel windows. Call once on the tray thread.
pub fn init(shared: Arc<session::Shared>) {
    unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("BufferMixer");
        let sink_class = wide("BufferWheelSink");
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(wndproc);
        wc.hInstance = hinst;
        wc.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        let mut sc: WNDCLASSW = std::mem::zeroed();
        sc.lpfnWndProc = Some(sink_proc);
        sc.hInstance = hinst;
        sc.lpszClassName = sink_class.as_ptr();
        RegisterClassW(&sc);
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED,
            class.as_ptr(),
            wide("Buffer").as_ptr(),
            WS_POPUP,
            0,
            0,
            10,
            10,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        );
        // a never-shown window (not message-only: Raw Input's sink needs a real one)
        let sink = CreateWindowExW(WS_EX_TOOLWINDOW, sink_class.as_ptr(), wide("").as_ptr(), WS_POPUP, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), hinst, std::ptr::null());
        SINK.with(|s| s.set(sink));
        if hwnd.is_null() {
            session::log("mixer flyout: window not created");
            return;
        }
        FLY.with(|f| {
            *f.borrow_mut() = Some(Flyout {
                hwnd,
                shared,
                devs: Vec::new(),
                rows: Vec::new(),
                cards: Vec::new(),
                s: 1.0,
                w: 0,
                h: 0,
                pos: (0, 0),
                dir: 1,
                scroll: 0.0,
                content: 0.0,
                mem: std::ptr::null_mut(),
                bmp: std::ptr::null_mut(),
                px: std::ptr::null_mut(),
                fonts: None,
                icons: HashMap::new(),
                drag: None,
                hover: None,
                hover_x: 0.0,
                tracking: false,
                anim: None,
                t0: Instant::now(),
                closed_at: None,
                frame: 0,
                wheel_rest: 0,
            })
        });
    }
}

/// Left click on the audio icon: opens the flyout above it, or closes it when it is open.
pub fn toggle(anchor: RECT) {
    FLY.with(|f| {
        if let Ok(mut g) = f.try_borrow_mut() {
            if let Some(fl) = g.as_mut() {
                fl.toggle(anchor);
            }
        }
    });
}

/// The pointer entered (`Some`) or left (`None`) the audio icon: the wheel sink follows it.
pub fn hover_icon(rect: Option<RECT>) {
    ICON_RECT.with(|r| r.set(rect));
    let want = rect.is_some();
    if SINK_ON.with(|s| s.get()) == want {
        return;
    }
    let sink = SINK.with(|s| s.get());
    if sink.is_null() {
        return;
    }
    let dev = RAWINPUTDEVICE {
        usUsagePage: 0x01, // generic desktop
        usUsage: 0x02,     // mouse
        dwFlags: if want { RIDEV_INPUTSINK } else { RIDEV_REMOVE },
        hwndTarget: if want { sink } else { std::ptr::null_mut() },
    };
    let ok = unsafe { RegisterRawInputDevices(&dev, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) } != 0;
    if ok {
        SINK_ON.with(|s| s.set(want));
    }
}

impl Flyout {
    fn open(&self) -> bool {
        matches!(self.anim, Some(Anim::Opening(_)) | Some(Anim::Open))
    }

    fn toggle(&mut self, anchor: RECT) {
        if self.open() {
            self.hide();
            return;
        }
        // the click that opened it a moment ago also took the focus away, which closed it: don't reopen
        if self.closed_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
            return;
        }
        self.show(anchor);
    }

    fn show(&mut self, anchor: RECT) {
        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            self.s = GetDeviceCaps(dc, LOGPIXELSX as i32) as f64 / 96.0;
            ReleaseDC(std::ptr::null_mut(), dc);
        }
        self.make_fonts();
        self.scroll = 0.0;
        self.refresh();
        self.place(anchor);
        self.anim = Some(Anim::Opening(Instant::now()));
        self.t0 = Instant::now();
        self.frame = 0;
        self.paint();
        unsafe {
            SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetForegroundWindow(self.hwnd);
            SetTimer(self.hwnd, 1, 16, None);
        }
    }

    /// Starts the fade-out; the window goes away when it ends.
    fn hide(&mut self) {
        if !self.open() {
            return;
        }
        self.anim = Some(Anim::Closing(Instant::now()));
        self.closed_at = Some(Instant::now());
        self.drag = None;
        self.hover = None;
        unsafe {
            ReleaseCapture();
            SetTimer(self.hwnd, 1, 16, None);
        }
    }

    fn gone(&mut self) {
        self.anim = None;
        unsafe {
            KillTimer(self.hwnd, 1);
            ShowWindow(self.hwnd, SW_HIDE);
        }
        // drop the COM objects: nothing is held or polled while closed
        self.devs.clear();
        self.rows.clear();
        self.cards.clear();
    }

    fn make_fonts(&mut self) {
        if let Some(f) = self.fonts.take() {
            unsafe {
                for h in [f.brand, f.label, f.big, f.num, f.small, f.button] {
                    DeleteObject(h);
                }
            }
        }
        let s = self.s;
        // the app's Instrument Sans / JetBrains Mono ship as web fonts only: Segoe UI and Cascadia Mono are the
        // closest ones Windows has (Consolas before Windows 11)
        let mono = if std::path::Path::new(&crate::win::expand_env(r"%WINDIR%\Fonts\CascadiaMono.ttf")).exists() { "Cascadia Mono" } else { "Consolas" };
        // ClearType for its sharpness; its colour fringes are taken out after drawing (`present`'s caller greys the text)
        let font = |face: &str, size: f64, weight: i32| unsafe { CreateFontW(-((size * s).round() as i32), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, wide(face).as_ptr()) };
        let (brand, button) = (font("Segoe UI", 14.0, 700), font("Segoe UI", 12.5, 600));
        let measure = |f: HFONT, text: &str| unsafe {
            let dc = GetDC(std::ptr::null_mut());
            let old = SelectObject(dc, f);
            let w = wide(text);
            let mut sz = SIZE { cx: 0, cy: 0 };
            GetTextExtentPoint32W(dc, w.as_ptr(), (w.len() - 1) as i32, &mut sz);
            SelectObject(dc, old);
            ReleaseDC(std::ptr::null_mut(), dc);
            sz.cx as f64 / s
        };
        self.fonts = Some(Fonts {
            brand_w: measure(brand, "Buffer"),
            open_w: measure(button, &crate::lang::t("mix.open")),
            brand,
            label: font("Segoe UI", 11.0, 600),
            big: font(mono, 15.0, 400),
            num: font(mono, 13.0, 400),
            small: font("Segoe UI", 11.0, 400),
            button,
        });
    }

    /// Re-reads devices and apps and lays the cards out.
    fn refresh(&mut self) {
        let hidden = self.shared.cfg.lock().unwrap().hidden_outputs.clone();
        self.devs = mixer::snapshot().into_iter().filter(|d| d.default || !hidden.contains(&d.id)).collect();
        self.rows.clear();
        self.cards.clear();
        let mut y = PAD;
        self.rows.push(Row { kind: Kind::Top, y, h: TOP });
        y += TOP;
        for (d, dev) in self.devs.iter().enumerate() {
            let top = y;
            self.rows.push(Row { kind: Kind::Label(d), y, h: LABEL });
            y += LABEL;
            self.rows.push(Row { kind: Kind::Master(d), y, h: MASTER });
            y += MASTER;
            for a in 0..dev.apps.len() {
                self.rows.push(Row { kind: Kind::App(d, a), y, h: APP });
                y += APP;
            }
            y += CARD_BOTTOM;
            self.cards.push((top, y));
            y += GAP;
        }
        self.rows.push(Row { kind: Kind::Footer, y, h: FOOT });
        self.content = y + FOOT + PAD;
    }

    fn work_area(&self, p: POINT) -> (RECT, RECT) {
        unsafe {
            let mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(mon, &mut mi);
            (mi.rcWork, mi.rcMonitor)
        }
    }

    /// Sizes the window to its content (within the work area) and puts it next to the icon, on the taskbar's side.
    fn place(&mut self, anchor: RECT) {
        let c = POINT { x: (anchor.left + anchor.right) / 2, y: (anchor.top + anchor.bottom) / 2 };
        let (work, full) = self.work_area(c);
        let gap = (12.0 * self.s).round() as i32;
        let w = (W * self.s).round() as i32;
        let max_h = (work.bottom - work.top) - 2 * gap;
        let h = ((self.content * self.s).round() as i32).min(max_h);
        let (x, y, dir) = if work.bottom < full.bottom {
            (c.x - w / 2, work.bottom - h - gap, 1)
        } else if work.top > full.top {
            (c.x - w / 2, work.top + gap, -1)
        } else if work.left > full.left {
            (work.left + gap, c.y - h / 2, 0)
        } else {
            (work.right - w - gap, c.y - h / 2, 0)
        };
        let x = x.clamp(work.left + gap, (work.right - w - gap).max(work.left));
        let y = y.clamp(work.top + gap, (work.bottom - h - gap).max(work.top));
        self.pos = (x, y);
        self.dir = dir;
        self.resize(w, h);
    }

    fn resize(&mut self, w: i32, h: i32) {
        if (w, h) == (self.w, self.h) && !self.mem.is_null() {
            return;
        }
        unsafe {
            if !self.mem.is_null() {
                DeleteDC(self.mem);
                DeleteObject(self.bmp);
            }
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h; // top-down
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            self.bmp = CreateDIBSection(std::ptr::null_mut(), &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            self.mem = CreateCompatibleDC(std::ptr::null_mut());
            SelectObject(self.mem, self.bmp);
            self.px = bits as *mut u32;
        }
        self.w = w;
        self.h = h;
    }

    /// New height after an app started or quit: the window grows away from the taskbar.
    fn fit(&mut self) {
        let want = (self.content * self.s).round() as i32;
        let (work, _) = self.work_area(POINT { x: self.pos.0, y: self.pos.1 });
        let gap = (12.0 * self.s).round() as i32;
        let h = want.min((work.bottom - work.top) - 2 * gap);
        if h != self.h {
            let bottom = self.pos.1 + self.h;
            if self.dir >= 0 {
                self.pos.1 = bottom - h;
            }
            let w = self.w;
            self.resize(w, h);
        }
        let max_scroll = (self.content - self.h as f64 / self.s).max(0.0);
        self.scroll = self.scroll.min(max_scroll);
    }

    fn icon(&mut self, src: &str) -> HICON {
        if let Some(h) = self.icons.get(src) {
            return *h;
        }
        let (path, idx) = crate::win::icon_source(src);
        let mut large: HICON = std::ptr::null_mut();
        if !path.is_empty() {
            unsafe {
                ExtractIconExW(wide(&path).as_ptr(), idx, &mut large, std::ptr::null_mut(), 1);
            }
        }
        self.icons.insert(src.to_string(), large);
        large
    }

    fn row_at(&self, ly: f64) -> Option<usize> {
        let y = ly + self.scroll;
        self.rows.iter().position(|r| y >= r.y && y < r.y + r.h)
    }

    fn target_of(&self, kind: Kind) -> Option<Target> {
        match kind {
            Kind::Top | Kind::Footer | Kind::Label(_) => None,
            Kind::Master(d) => Some(Target::Dev(self.devs.get(d)?.id.clone())),
            Kind::App(d, a) => {
                let dev = self.devs.get(d)?;
                Some(Target::App(dev.id.clone(), dev.apps.get(a)?.key.clone()))
            }
        }
    }

    fn get(&self, t: &Target) -> Option<(f32, bool)> {
        match t {
            Target::Dev(id) => self.devs.iter().find(|d| &d.id == id).map(|d| (d.volume(), d.muted())),
            Target::App(id, key) => {
                let a = self.devs.iter().find(|d| &d.id == id)?.apps.iter().find(|a| &a.key == key)?;
                Some((a.volume(), a.muted()))
            }
        }
    }

    fn set(&self, t: &Target, v: Option<f32>, mute: Option<bool>) {
        match t {
            Target::Dev(id) => {
                if let Some(d) = self.devs.iter().find(|d| &d.id == id) {
                    if let Some(v) = v {
                        d.set_volume(v);
                    }
                    if let Some(m) = mute {
                        d.set_muted(m);
                    }
                }
            }
            Target::App(id, key) => {
                if let Some(a) = self.devs.iter().find(|d| &d.id == id).and_then(|d| d.apps.iter().find(|a| &a.key == key)) {
                    if let Some(v) = v {
                        a.set_volume(v);
                    }
                    if let Some(m) = mute {
                        a.set_muted(m);
                    }
                }
            }
        }
        if matches!(t, Target::Dev(_)) {
            crate::tray::audio_changed();
        }
    }

    fn value_at(lx: f64) -> f32 {
        ((((lx - SL_X0) / (SL_X1 - SL_X0)).clamp(0.0, 1.0) * 100.0).round() / 100.0) as f32
    }

    fn on_msg(&mut self, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        let s = self.s;
        match msg {
            WM_TIMER => {
                match self.anim {
                    Some(Anim::Opening(t)) if t.elapsed().as_secs_f64() * 1000.0 >= OPEN_MS => {
                        self.anim = Some(Anim::Open);
                        unsafe {
                            SetTimer(self.hwnd, 1, 33, None);
                        }
                    }
                    Some(Anim::Closing(t)) if t.elapsed().as_secs_f64() * 1000.0 >= CLOSE_MS => {
                        self.gone();
                        return Some(0);
                    }
                    None => return Some(0),
                    _ => {}
                }
                self.frame += 1;
                if matches!(self.anim, Some(Anim::Open)) && self.frame % 30 == 0 && self.drag.is_none() {
                    self.refresh();
                    self.fit();
                }
                self.paint();
                Some(0)
            }
            WM_ACTIVATE => {
                if (wp & 0xffff) as u32 == WA_INACTIVE {
                    self.hide();
                }
                None
            }
            WM_KEYDOWN => {
                if wp as u16 == VK_ESCAPE {
                    self.hide();
                }
                Some(0)
            }
            WM_SETCURSOR => {
                let clickable = self.hover.and_then(|i| self.rows.get(i)).is_some_and(|r| match r.kind {
                    Kind::Label(d) => self.devs.get(d).is_some_and(|d| !d.default),
                    Kind::Footer => (PAD..W - PAD).contains(&self.hover_x),
                    _ => false,
                });
                if clickable {
                    unsafe {
                        SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_HAND));
                    }
                    return Some(1);
                }
                None
            }
            WM_LBUTTONDOWN => {
                if !self.open() {
                    return Some(0);
                }
                let (lx, ly) = (lo(lp) as f64 / s, hi(lp) as f64 / s);
                let Some(i) = self.row_at(ly) else { return Some(0) };
                let kind = self.rows[i].kind;
                match kind {
                    Kind::Top => {}
                    Kind::Footer => {
                        if (PAD..W - PAD).contains(&lx) {
                            crate::tray::open_app_view("snd");
                            self.hide();
                        }
                    }
                    Kind::Label(d) => {
                        if let Some(dev) = self.devs.get(d).filter(|d| !d.default) {
                            match crate::endpoints::set_default_output(&dev.id) {
                                Ok(()) => crate::eq::follow_output(&self.shared),
                                Err(e) => session::log(&format!("output switch: {e}")),
                            }
                            self.refresh();
                            self.fit();
                            crate::tray::audio_changed();
                        }
                    }
                    _ => {
                        let Some(t) = self.target_of(kind) else { return Some(0) };
                        if lx < MUTE_X {
                            if let Some((_, m)) = self.get(&t) {
                                self.set(&t, None, Some(!m));
                            }
                        } else if lx >= SL_X0 - 12.0 && lx <= SL_X1 + 12.0 {
                            self.set(&t, Some(Self::value_at(lx)), None);
                            self.drag = Some(t);
                            unsafe {
                                SetCapture(self.hwnd);
                            }
                        }
                    }
                }
                self.paint();
                Some(0)
            }
            WM_MOUSEMOVE => {
                let (lx, ly) = (lo(lp) as f64 / s, hi(lp) as f64 / s);
                self.hover_x = lx;
                if let Some(t) = self.drag.clone() {
                    self.set(&t, Some(Self::value_at(lx)), None);
                } else {
                    self.hover = self.row_at(ly);
                    if !self.tracking {
                        let mut tme = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: self.hwnd, dwHoverTime: 0 };
                        self.tracking = unsafe { TrackMouseEvent(&mut tme) } != 0;
                    }
                }
                // the 33 ms timer draws it: a mouse sends far more moves than that
                Some(0)
            }
            WM_LBUTTONUP => {
                if self.drag.take().is_some() {
                    unsafe {
                        ReleaseCapture();
                    }
                }
                Some(0)
            }
            WM_MOUSELEAVE => {
                self.tracking = false;
                self.hover = None;
                Some(0)
            }
            WM_MOUSEWHEEL => {
                self.wheel_rest += ((wp >> 16) & 0xffff) as i16 as i32;
                let notches = self.wheel_rest / 120;
                self.wheel_rest %= 120;
                if notches == 0 {
                    return Some(0);
                }
                let mut p = POINT { x: lo(lp), y: hi(lp) };
                unsafe {
                    ScreenToClient(self.hwnd, &mut p);
                }
                let view = self.h as f64 / s;
                let target = self.row_at(p.y as f64 / s).and_then(|i| self.target_of(self.rows[i].kind));
                match target {
                    // over a slider row the wheel sets that volume
                    Some(t) => {
                        if let Some((v, _)) = self.get(&t) {
                            self.set(&t, Some(mixer::step(v, notches as f32)), None);
                        }
                    }
                    // elsewhere it scrolls, when there are more devices than the screen holds
                    None if self.content > view + 0.5 => {
                        self.scroll = (self.scroll - notches as f64 * 40.0).clamp(0.0, self.content - view);
                    }
                    None => {}
                }
                self.paint();
                Some(0)
            }
            _ => None,
        }
    }

    fn paint(&mut self) {
        let Some(anim) = &self.anim else { return };
        if self.mem.is_null() {
            return;
        }
        let (alpha, offset) = match anim {
            Anim::Opening(t) => {
                let e = ease_out(t.elapsed().as_secs_f64() * 1000.0 / OPEN_MS);
                (e, (1.0 - e) * 14.0)
            }
            Anim::Open => (1.0, 0.0),
            Anim::Closing(t) => {
                let e = (t.elapsed().as_secs_f64() * 1000.0 / CLOSE_MS).clamp(0.0, 1.0);
                (1.0 - e, e * 6.0)
            }
        };
        let s = self.s;
        let th = theme();
        let mut cv = Canvas { px: self.px, w: self.w, h: self.h };
        let (w, h) = (self.w as f64, self.h as f64);
        unsafe {
            GdiFlush();
        }
        // the window: 1px line outline around the app background
        cv.fill(0.0, 0.0, w, h, th.line);
        cv.rrect(1.0, 1.0, w - 1.0, h - 1.0, RADIUS * s - 1.0, th.bg);
        let y_of = |y: f64| (y - self.scroll) * s;
        for &(top, bottom) in &self.cards {
            let (y0, y1) = (y_of(top), y_of(bottom));
            if y1 < 0.0 || y0 > h {
                continue;
            }
            cv.rrect(PAD * s, y0, (W - PAD) * s, y1, 12.0 * s, th.line);
            cv.rrect(PAD * s + 1.0, y0 + 1.0, (W - PAD) * s - 1.0, y1 - 1.0, 12.0 * s - 1.0, th.panel);
        }
        // values read once per frame and reused by the text pass
        struct Line {
            top: f64,
            h: f64,
            kind: Kind,
            v: f32,
            muted: bool,
        }
        let mut lines: Vec<Line> = Vec::new();
        // all app meters of a device in one go: the loopback check compares them with each other
        let peaks: Vec<Vec<f32>> = self.devs.iter().map(|d| d.app_peaks()).collect();
        for (i, r) in self.rows.iter().enumerate() {
            let top = y_of(r.y);
            if top > h || top + r.h * s < 0.0 {
                continue;
            }
            let (v, muted, peak) = match r.kind {
                Kind::Top | Kind::Footer | Kind::Label(_) => (0.0, false, 0.0),
                Kind::Master(d) => self.devs.get(d).map(|d| (d.volume(), d.muted(), d.peak())).unwrap_or_default(),
                Kind::App(d, a) => self.devs.get(d).and_then(|dv| dv.apps.get(a).map(|ap| (ap.volume(), ap.muted(), peaks[d].get(a).copied().unwrap_or(0.0)))).unwrap_or_default(),
            };
            match r.kind {
                Kind::Top => {
                    // the logo mark and the name, centred: seven 2 px bars, widest in the middle, animated like the
                    // app's top bar (each bar grows in, then ripples now and then)
                    let brand_w = self.fonts.as_ref().map_or(48.0, |f| f.brand_w);
                    let (x0, yc) = ((W - (17.0 + 9.0 + brand_w)) / 2.0 * s, top + TOP * s / 2.0);
                    let t = self.t0.elapsed().as_secs_f64();
                    for (j, bw) in [5.0, 9.0, 13.0, 17.0, 13.0, 9.0, 5.0].iter().enumerate() {
                        let y = yc + (j as f64 - 3.0) * 3.5 * s - 1.0 * s;
                        let k = logo_bar_scale(j, t);
                        cv.rrect(x0, y, x0 + bw * k * s, y + 2.0 * s, 1.0 * s, ACC);
                    }
                }
                Kind::Footer => {
                    // a full-width button in the app's style: raised surface, a slightly lighter edge
                    let hover = self.hover == Some(i);
                    let edge = mix(th.raised, TEXT, if hover { 0.22 } else { 0.1 });
                    let face = if hover { mix(th.raised, TEXT, 0.05) } else { th.raised };
                    cv.rrect(PAD * s, top, (W - PAD) * s, top + FOOT * s, 10.0 * s, edge);
                    cv.rrect(PAD * s + 1.0, top + 1.0, (W - PAD) * s - 1.0, top + FOOT * s - 1.0, 10.0 * s - 1.0, face);
                    // the "open" arrow (lime), left of the centred label
                    let open_w = self.fonts.as_ref().map_or(140.0, |f| f.open_w);
                    let ax = ((W - (12.0 + 8.0 + open_w)) / 2.0) * s;
                    let ay = top + (FOOT - 12.0) / 2.0 * s;
                    let stroke = |cv: &mut Canvas, a: (f64, f64), b: (f64, f64)| {
                        let n = 16;
                        for k in 0..=n {
                            let t = k as f64 / n as f64;
                            cv.disc(ax + (a.0 + (b.0 - a.0) * t) * s, ay + (a.1 + (b.1 - a.1) * t) * s, 0.85 * s, ACC);
                        }
                    };
                    stroke(&mut cv, (4.0, 2.0), (10.0, 2.0));
                    stroke(&mut cv, (10.0, 2.0), (10.0, 8.0));
                    stroke(&mut cv, (10.0, 2.0), (3.0, 9.0));
                }
                Kind::Label(d) => {
                    if self.devs.get(d).is_some_and(|d| d.default) {
                        cv.disc((PAD + 17.0) * s, top + LABEL * s / 2.0 + 1.0 * s, 3.0 * s, ACC);
                    }
                }
                Kind::Master(_) | Kind::App(..) => {
                    let yc = top + r.h * s / 2.0;
                    let (x0, x1) = (SL_X0 * s, SL_X1 * s);
                    let xv = x0 + (x1 - x0) * v as f64;
                    let fillc = if muted { SUBTLE } else { ACC };
                    // the volume: a smooth line, full lime up to the value (the user moves it, so it never steps)
                    cv.rrect(x0, yc - 4.0 * s, x1, yc, 2.0 * s, th.line);
                    cv.rrect(x0, yc - 4.0 * s, xv, yc, 2.0 * s, fillc);
                    // under it the app's "scan" (export and update progress) shows only what plays right now
                    let level = if muted { 0.0 } else { (v * peak) as f64 };
                    for (_, x, xe) in scan_segments(x0, x1, s) {
                        let f = ((x + xe) / 2.0 - x0) / (x1 - x0);
                        cv.rrect_a(x, yc + 4.0 * s, xe, yc + 7.0 * s, 1.0 * s, ACC, scan_alpha(f, level));
                    }
                    // the value marker is a playhead, with a ring of the card's colour so it reads over the line
                    let active = self.hover == Some(i) || self.drag.as_ref().is_some_and(|t| self.target_of(r.kind).as_ref() == Some(t));
                    let tw = if active { 4.0 * s } else { 3.0 * s };
                    let (t0, t1) = (yc - 10.0 * s, yc + 6.0 * s);
                    cv.rrect(xv - tw / 2.0 - 2.0 * s, t0 - 2.0 * s, xv + tw / 2.0 + 2.0 * s, t1 + 2.0 * s, 3.0 * s, th.panel);
                    cv.rrect(xv - tw / 2.0, t0, xv + tw / 2.0, t1, 1.5 * s, if muted { SUBTLE } else { TEXT });
                    if let Kind::Master(_) = r.kind {
                        draw_speaker(&mut cv, (PAD + 12.0) * s, yc - 12.0 * s, 24.0 * s, waves_for(v), muted);
                    }
                }
            }
            lines.push(Line { top, h: r.h * s, kind: r.kind, v, muted });
        }
        // GDI pass: text and app icons
        let mut icons: Vec<(HICON, String)> = Vec::new();
        for l in &lines {
            if let Kind::App(d, a) = l.kind {
                let (src, name) = match self.devs.get(d).and_then(|d| d.apps.get(a)) {
                    Some(app) => (app.icon.clone(), app.name.clone()),
                    None => (String::new(), String::new()),
                };
                icons.push((self.icon(&src), name));
            }
        }
        let Some(f) = self.fonts.as_ref() else { return };
        let (brand, label, big, num, small, button, brand_w, open_w) = (f.brand, f.label, f.big, f.num, f.small, f.button, f.brand_w, f.open_w);
        unsafe {
            let dc = self.mem;
            SetBkMode(dc, TRANSPARENT as i32);
            let drawn: RefCell<Vec<RECT>> = RefCell::new(Vec::new());
            let text = |font: HFONT, c: Rgb, x0: f64, y0: f64, x1: f64, y1: f64, s_: &str, flags: u32| {
                SelectObject(dc, font);
                SetTextColor(dc, cref(c));
                let mut rc = RECT { left: x0.round() as i32, top: y0.round() as i32, right: x1.round() as i32, bottom: y1.round() as i32 };
                let w = wide(s_);
                drawn.borrow_mut().push(rc);
                DrawTextW(dc, w.as_ptr(), (w.len() - 1) as i32, &mut rc, flags | DT_SINGLELINE | DT_NOPREFIX | DT_VCENTER);
            };
            let mut app_i = 0;
            for l in &lines {
                let hovered = self.hover.is_some_and(|i| self.rows.get(i).is_some_and(|r| r.kind == l.kind));
                match l.kind {
                    Kind::Top => {
                        let x = (W - (17.0 + 9.0 + brand_w)) / 2.0 + 26.0;
                        text(brand, TEXT, x * s, l.top, (x + brand_w + 4.0) * s, l.top + l.h, "Buffer", DT_LEFT);
                    }
                    Kind::Footer => {
                        let x = (W - (12.0 + 8.0 + open_w)) / 2.0 + 20.0;
                        text(button, TEXT, x * s, l.top, (x + open_w + 4.0) * s, l.top + l.h, &crate::lang::t("mix.open"), DT_LEFT);
                    }
                    Kind::Label(d) => {
                        let Some(dev) = self.devs.get(d) else { continue };
                        // the app's section caption: small caps, spaced out
                        let c = if dev.default || hovered { TEXT } else { MUTED };
                        let x = if dev.default { PAD + 26.0 } else { PAD + 14.0 };
                        SetTextCharacterExtra(dc, (1.0 * s).round() as i32);
                        text(label, c, x * s, l.top + 4.0 * s, (W - PAD - 14.0) * s, l.top + l.h, &dev.name.to_uppercase(), DT_LEFT | DT_END_ELLIPSIS);
                        SetTextCharacterExtra(dc, 0);
                    }
                    Kind::Master(_) | Kind::App(..) => {
                        let font = if matches!(l.kind, Kind::Master(_)) { big } else { num };
                        let c = if l.muted { SUBTLE } else { TEXT };
                        let n = format!("{}", (l.v * 100.0).round() as i32);
                        text(font, c, (SL_X1 + 8.0) * s, l.top, NUM_RIGHT * s, l.top + l.h, &n, DT_RIGHT);
                        if let Kind::App(..) = l.kind {
                            let (hicon, name) = &icons[app_i];
                            app_i += 1;
                            let sz = (20.0 * s).round() as i32;
                            let (ix, iy) = (((PAD + 14.0) * s).round() as i32, (l.top + (l.h - sz as f64) / 2.0).round() as i32);
                            if !hicon.is_null() {
                                DrawIconEx(dc, ix, iy, *hicon, sz, sz, 0, std::ptr::null_mut(), DI_NORMAL);
                            } else {
                                let first: String = name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
                                text(label, MUTED, ix as f64, iy as f64, (ix + sz) as f64, (iy + sz) as f64, &first, DT_CENTER);
                            }
                            if hovered {
                                text(small, MUTED, SL_X0 * s, l.top, SL_X1 * s, l.top + 12.0 * s, name, DT_LEFT | DT_END_ELLIPSIS);
                            }
                        }
                    }
                }
            }
            GdiFlush();
            // all text is neutral: grey ClearType's coloured subpixels (orange/blue fringes over the dark panel)
            for rc in drawn.into_inner() {
                for y in rc.top.max(0)..rc.bottom.min(self.h) {
                    for x in rc.left.max(0)..rc.right.min(self.w) {
                        let p = self.px.add((y * self.w + x) as usize);
                        let (r, g, b) = ((*p >> 16) & 0xff, (*p >> 8) & 0xff, *p & 0xff);
                        let l = (r + g + b) / 3;
                        *p = l << 16 | l << 8 | l;
                    }
                }
            }
        }
        // muted apps: a small red cross on the icon's corner
        for l in &lines {
            if let (Kind::App(..), true) = (l.kind, l.muted) {
                let (cx, cy) = ((PAD + 33.0) * s, l.top + l.h / 2.0 + 7.0 * s);
                cv.disc(cx, cy, 6.0 * s, th.panel);
                let steps = 12;
                for i in 0..=steps {
                    let t = (-3.0 + 6.0 * i as f64 / steps as f64) * s;
                    cv.disc(cx + t, cy + t, 1.0 * s, BAD);
                    cv.disc(cx + t, cy - t, 1.0 * s, BAD);
                }
            }
        }
        self.present(alpha, offset);
    }

    /// Gives every pixel its alpha (opaque inside, anti-aliased round corners, premultiplied) and shows the frame.
    fn present(&mut self, alpha: f64, offset: f64) {
        let (w, h) = (self.w, self.h);
        let r = RADIUS * self.s;
        let n = (w * h) as usize;
        let px = unsafe { std::slice::from_raw_parts_mut(self.px, n) };
        for p in px.iter_mut() {
            *p |= 0xff00_0000;
        }
        let ri = r.ceil() as i32;
        for y in (0..ri).chain(h - ri..h) {
            for x in (0..ri).chain(w - ri..w) {
                if x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let qx = ((x as f64 + 0.5 - w as f64 / 2.0).abs() - (w as f64 / 2.0 - r)).max(0.0);
                let qy = ((y as f64 + 0.5 - h as f64 / 2.0).abs() - (h as f64 / 2.0 - r)).max(0.0);
                let a = (0.5 - ((qx * qx + qy * qy).sqrt() - r)).clamp(0.0, 1.0);
                if a < 1.0 {
                    let p = &mut px[(y * w + x) as usize];
                    let k = |c: u32| ((c & 0xff) as f64 * a).round() as u32;
                    *p = ((a * 255.0).round() as u32) << 24 | k(*p >> 16) << 16 | k(*p >> 8) << 8 | k(*p);
                }
            }
        }
        let dy = (offset * self.s).round() as i32 * if self.dir < 0 { -1 } else { 1 };
        let dx = if self.dir == 0 { (offset * self.s).round() as i32 } else { 0 };
        let dst = POINT { x: self.pos.0 + dx, y: self.pos.1 + dy };
        let size = SIZE { cx: w, cy: h };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: (alpha.clamp(0.0, 1.0) * 255.0).round() as u8, AlphaFormat: AC_SRC_ALPHA as u8 };
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            UpdateLayeredWindow(self.hwnd, screen, &dst, &size, self.mem, &src, 0, &blend, ULW_ALPHA);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        let _ = SWP_NOACTIVATE;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn speaker_is_seven_scan_lines_with_three_waves() {
        let bars = super::speaker_bars();
        let rows: std::collections::BTreeSet<i32> = bars.iter().map(|b| b.1 as i32).collect();
        assert_eq!(rows.len(), 7, "seven bars, like the logo");
        for n in 1..=3u8 {
            // wave n spans 2n+1 bars, centred
            assert_eq!(bars.iter().filter(|b| b.4 == n).count(), 2 * n as usize + 1);
        }
        assert!(bars.iter().all(|b| b.2 <= 32.0 && b.3 <= 32.0), "inside the 32-unit grid");
        assert_eq!(super::waves_for(0.0), 0);
        assert_eq!(super::waves_for(0.74), 3);
    }
}
