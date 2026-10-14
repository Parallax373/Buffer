//! `buffer-recorder identify`: shows a big number on every monitor for ~2.5 s, in the same order as the
//! "Ekran" setting, so two identical screens can be told apart.

use crate::win;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect, SelectObject, SetBkMode,
    SetTextColor, DT_CENTER, DT_SINGLELINE, DT_VCENTER, PAINTSTRUCT, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW, ShowWindow, TranslateMessage,
    CS_HREDRAW, CS_VREDRAW, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

static LABELS: Mutex<Option<HashMap<isize, String>>> = Mutex::new(None);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_PAINT {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let dc = BeginPaint(hwnd, &mut ps);
        let mut rc: RECT = std::mem::zeroed();
        windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rc);
        let bg = CreateSolidBrush(0x001f1a18);
        FillRect(dc, &rc, bg);
        DeleteObject(bg);
        let edge = CreateSolidBrush(0x0032f4c6);
        for k in 0..3 {
            let r = RECT { left: rc.left + k, top: rc.top + k, right: rc.right - k, bottom: rc.bottom - k };
            FrameRect(dc, &r, edge);
        }
        DeleteObject(edge);
        let label = LABELS.lock().unwrap().as_ref().and_then(|m| m.get(&(hwnd as isize)).cloned()).unwrap_or_default();
        let height = rc.bottom - rc.top;
        let font = CreateFontW(-(height * 6 / 10), 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 5, 0, wide("Segoe UI").as_ptr());
        let old = SelectObject(dc, font);
        SetBkMode(dc, TRANSPARENT as i32);
        SetTextColor(dc, 0x0032f4c6);
        DrawTextW(dc, wide(&label).as_ptr(), -1, &mut rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(dc, old);
        DeleteObject(font);
        EndPaint(hwnd, &ps);
        return 0;
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

pub fn run() {
    win::make_dpi_aware();
    let mons = win::monitors();
    unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("BufferIdentify");
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
        let mut windows = Vec::new();
        let mut map = HashMap::new();
        for (i, m) in mons.iter().enumerate() {
            let size = (m.height.min(m.width) / 5).max(160);
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class.as_ptr(),
                wide("Buffer").as_ptr(),
                WS_POPUP,
                m.left + size / 4,
                m.top + size / 4,
                size,
                size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            if !hwnd.is_null() {
                map.insert(hwnd as isize, (i + 1).to_string());
                windows.push(hwnd);
            }
        }
        *LABELS.lock().unwrap() = Some(map);
        for h in &windows {
            ShowWindow(*h, SW_SHOWNOACTIVATE);
        }
        let until = Instant::now() + Duration::from_millis(2500);
        let mut msg: MSG = std::mem::zeroed();
        while Instant::now() < until {
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        for h in windows {
            DestroyWindow(h);
        }
    }
}
