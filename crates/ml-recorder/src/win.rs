//! Small Win32 helpers: single instance, job object, hotkey, foreground app, local time.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, RECT, SYSTEMTIME};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, MB_OK, MSG, WM_HOTKEY,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Returns false when another instance already holds the named mutex.
/// The handle is intentionally leaked: it must live as long as the process.
pub fn claim_single_instance(name: &str) -> bool {
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 1, wide(name).as_ptr());
        if h.is_null() {
            return true; // could not create; do not block startup
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(h);
            return false;
        }
        true
    }
}

/// A job object that kills every assigned process when the recorder exits or crashes,
/// so a stray ffmpeg can never keep recording on its own.
pub struct Job(HANDLE);
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Option<Job> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return None;
            }
            Some(Job(h))
        }
    }

    pub fn assign(&self, child: &std::process::Child) {
        unsafe {
            AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
        }
    }
}

/// Parses "Ctrl+Alt+F9" into (modifiers, virtual-key).
fn parse_hotkey(spec: &str) -> Option<(u32, u32)> {
    let mut mods = MOD_NOREPEAT;
    let mut vk = None;
    for part in spec.split('+').map(|p| p.trim().to_ascii_lowercase()) {
        match part.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" => mods |= MOD_WIN,
            k if k.len() == 1 => {
                let c = k.chars().next()?.to_ascii_uppercase();
                if c.is_ascii_alphanumeric() {
                    vk = Some(c as u32);
                }
            }
            k if k.starts_with('f') => {
                let n: u32 = k[1..].parse().ok()?;
                if (1..=24).contains(&n) {
                    vk = Some(0x70 + n - 1); // VK_F1 = 0x70
                }
            }
            _ => return None,
        }
    }
    vk.map(|v| (mods, v))
}

/// Registers a thread-level global hotkey; its presses arrive as WM_HOTKEY in this thread's queue.
pub fn register_hotkey(spec: &str) -> Result<(), String> {
    let (mods, vk) = parse_hotkey(spec).ok_or_else(|| format!("invalid hotkey '{spec}'"))?;
    unsafe {
        if RegisterHotKey(std::ptr::null_mut(), 1, mods, vk) == 0 {
            return Err(format!("hotkey '{spec}' is already taken by another program"));
        }
    }
    Ok(())
}

/// Runs this thread's message loop. `on_hotkey` fires per press, `on_tick` every ~500 ms.
/// Dispatching messages also services the tray icon's hidden window.
pub fn pump_messages(mut on_hotkey: impl FnMut(), mut on_tick: impl FnMut()) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DispatchMessageW, SetTimer, TranslateMessage, WM_TIMER};
    unsafe {
        SetTimer(std::ptr::null_mut(), 1, 500, None);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            match msg.message {
                WM_HOTKEY => on_hotkey(),
                WM_TIMER => on_tick(),
                _ => {}
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

pub struct Foreground {
    pub pid: u32,
    /// Lower-case executable stem, e.g. "cs2".
    pub stem: String,
    /// The window covers its whole monitor (exclusive or borderless fullscreen).
    pub fullscreen: bool,
}

/// The program currently in the foreground, ignoring the desktop shell itself.
pub fn foreground() -> Option<Foreground> {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowRect};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) as usize;
        let class = String::from_utf16_lossy(&class[..n]);
        if ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class.as_str()) {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem = Path::new(&path).file_stem()?.to_string_lossy().to_lowercase();

        let mut r: RECT = std::mem::zeroed();
        let mut fullscreen = false;
        if GetWindowRect(hwnd, &mut r) != 0 {
            let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(mon, &mut mi) != 0 {
                let m = mi.rcMonitor;
                fullscreen = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
            }
        }
        Some(Foreground { pid, stem, fullscreen })
    }
}

/// File stem of the executable owning the foreground window.
pub fn foreground_exe_stem() -> Option<String> {
    foreground().map(|f| f.stem)
}

pub fn local_stamp() -> String {
    unsafe {
        let mut t: SYSTEMTIME = std::mem::zeroed();
        GetLocalTime(&mut t);
        format!(
            "{:04}-{:02}-{:02}__{:02}-{:02}-{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        )
    }
}

pub fn beep() {
    unsafe {
        MessageBeep(MB_OK);
    }
}

/// Make this process DPI aware so the popup is crisp and sized correctly on scaled displays.
pub fn make_dpi_aware() {
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SetProcessDPIAware();
    }
}

/// (width, height, is_primary) of every attached monitor, in enumeration order.
pub fn monitors() -> Vec<(i32, i32, bool)> {
    use windows_sys::Win32::Foundation::{BOOL, LPARAM};
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
    unsafe extern "system" fn cb(mon: HMONITOR, _dc: HDC, _r: *mut RECT, data: LPARAM) -> BOOL {
        let out = &mut *(data as *mut Vec<(i32, i32, bool)>);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) != 0 {
            let r = mi.rcMonitor;
            out.push((r.right - r.left, r.bottom - r.top, mi.dwFlags & 1 != 0));
        }
        1
    }
    let mut v: Vec<(i32, i32, bool)> = Vec::new();
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(cb), &mut v as *mut _ as LPARAM);
    }
    v
}
