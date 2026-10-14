//! A small always-on-top, click-through, non-activating popup ("Buffer active", "Clip saved").
//! Everything runs on the tray thread's message loop; other threads queue a `Popup` on a channel.
//! Note: like any overlay it cannot appear above a game in *exclusive* fullscreen (borderless is fine).

use std::sync::Mutex;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    SelectObject, SetBkMode, SetTextColor, SetWindowRgn, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
    PAINTSTRUCT, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetSystemMetrics, RegisterClassW, SetLayeredWindowAttributes,
    SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, LWA_ALPHA, SM_CXSCREEN,
    SWP_NOACTIVATE, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_PAINT, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Info,
    Ok,
    Warn,
    Error,
}

#[derive(Clone)]
pub struct Popup {
    pub title: String,
    pub sub: String,
    pub kind: Kind,
}

static CURRENT: Mutex<Option<Popup>> = Mutex::new(None);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

fn accent(kind: Kind) -> u32 {
    match kind {
        Kind::Info => rgb(0xc6, 0xf4, 0x32),
        Kind::Ok => rgb(0xc6, 0xf4, 0x32),
        Kind::Warn => rgb(0xff, 0xb4, 0x54),
        Kind::Error => rgb(0xff, 0x5d, 0x5d),
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            let popup = CURRENT.lock().unwrap().clone();
            if let Some(p) = popup {
                let mut rc: RECT = std::mem::zeroed();
                windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rc);
                let bg = CreateSolidBrush(rgb(0x18, 0x1a, 0x1f));
                FillRect(hdc, &rc, bg);
                DeleteObject(bg);
                let bar = CreateSolidBrush(accent(p.kind));
                let strip = RECT { left: 0, top: 0, right: 6, bottom: rc.bottom };
                FillRect(hdc, &strip, bar);
                DeleteObject(bar);

                SetBkMode(hdc, TRANSPARENT as i32);
                let height = rc.bottom - rc.top;
                let mk = |px: i32, weight: i32| {
                    CreateFontW(-px, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, wide("Segoe UI").as_ptr())
                };
                let scale = height as f32 / 78.0;
                let f1 = mk((19.0 * scale) as i32, 700);
                let f2 = mk((14.0 * scale) as i32, 400);

                // logo mark: scan-line triangle in the accent colour
                let mark = CreateSolidBrush(accent(p.kind));
                let faded = CreateSolidBrush(rgb(0x4a, 0x56, 0x2a));
                let n = 7;
                let bh = (4.0 * scale).max(2.0) as i32;
                let gap = (2.0 * scale).max(1.0) as i32;
                let total = n * bh + (n - 1) * gap;
                let top0 = (height - total) / 2;
                let x0 = (22.0 * scale) as i32;
                for i in 0..n {
                    let w = ((6 + (3 - (i - 3_i32).abs()) * 5) as f32 * scale * 1.1) as i32;
                    let y = top0 + i * (bh + gap);
                    let tail = RECT { left: x0 - (8.0 * scale) as i32, top: y, right: x0, bottom: y + bh };
                    FillRect(hdc, &tail, faded);
                    let bar = RECT { left: x0, top: y, right: x0 + w, bottom: y + bh };
                    FillRect(hdc, &bar, mark);
                }
                DeleteObject(mark);
                DeleteObject(faded);

                let pad = (84.0 * scale) as i32;
                let mut r1 = RECT { left: pad, top: (10.0 * scale) as i32, right: rc.right - pad, bottom: (42.0 * scale) as i32 };
                let old = SelectObject(hdc, f1);
                SetTextColor(hdc, rgb(0xe8, 0xea, 0xee));
                DrawTextW(hdc, wide(&p.title).as_ptr(), -1, &mut r1, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
                let mut r2 = RECT { left: pad, top: (42.0 * scale) as i32, right: rc.right - pad, bottom: (68.0 * scale) as i32 };
                SelectObject(hdc, f2);
                SetTextColor(hdc, rgb(0x8b, 0x91, 0x9c));
                DrawTextW(hdc, wide(&p.sub).as_ptr(), -1, &mut r2, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
                SelectObject(hdc, old);
                DeleteObject(f1);
                DeleteObject(f2);
            }
            EndPaint(hwnd, &ps);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// Owns the popup window. Create and use it on the thread that runs the message loop.
pub struct Overlay {
    hwnd: HWND,
    hide_at: Option<std::time::Instant>,
}

impl Overlay {
    pub fn new() -> Overlay {
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            let class = wide("BufferOverlay");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinst,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
            Overlay { hwnd: std::ptr::null_mut(), hide_at: None }
        }
    }

    pub fn show(&mut self, popup: Popup, millis: u64) {
        unsafe {
            if !self.hwnd.is_null() {
                DestroyWindow(self.hwnd);
                self.hwnd = std::ptr::null_mut();
            }
            let dpi = windows_sys::Win32::UI::HiDpi::GetDpiForSystem().max(96) as f32 / 96.0;
            let (w, h) = ((400.0 * dpi) as i32, (78.0 * dpi) as i32);
            let screen_w = GetSystemMetrics(SM_CXSCREEN);
            let x = screen_w - w - (24.0 * dpi) as i32;
            let y = (24.0 * dpi) as i32;
            *CURRENT.lock().unwrap() = Some(popup);

            let hinst = GetModuleHandleW(std::ptr::null());
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
                wide("BufferOverlay").as_ptr(),
                wide("Buffer").as_ptr(),
                WS_POPUP,
                x, y, w, h,
                std::ptr::null_mut(), std::ptr::null_mut(), hinst, std::ptr::null(),
            );
            if hwnd.is_null() {
                return;
            }
            SetLayeredWindowAttributes(hwnd, 0, 238, LWA_ALPHA);
            SetWindowRgn(hwnd, CreateRoundRectRgn(0, 0, w + 1, h + 1, (16.0 * dpi) as i32, (16.0 * dpi) as i32), 1);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            self.hwnd = hwnd;
            self.hide_at = Some(std::time::Instant::now() + std::time::Duration::from_millis(millis));
        }
    }

    /// Call from the periodic tick: closes the popup once its time is up.
    pub fn tick(&mut self) {
        if let Some(t) = self.hide_at {
            if std::time::Instant::now() >= t {
                unsafe {
                    if !self.hwnd.is_null() {
                        DestroyWindow(self.hwnd);
                        self.hwnd = std::ptr::null_mut();
                    }
                }
                self.hide_at = None;
            }
        }
    }
}
