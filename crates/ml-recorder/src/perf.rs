//! Measures what the recorder really costs: CPU time of this process plus the ffmpeg children in the job
//! object, and GPU engine utilisation of the same processes (Windows performance counters, no extra tools).
//! Sampled every two seconds; the values appear in the status as `cpu_pct` and `gpu_pct`.

use crate::session::Shared;
use std::{
    ffi::c_void,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::FILETIME,
    System::{
        JobObjects::{
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        },
        Performance::{
            PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
            PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
        },
        SystemInformation::{GetSystemInfo, SYSTEM_INFO},
        Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessTimes},
    },
};

const PDH_MORE_DATA: u32 = 0x800007D2;

fn filetime_100ns(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// CPU time (user + kernel, 100 ns units) used so far by this process.
fn own_cpu_time() -> u64 {
    unsafe {
        let (mut c, mut e, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) == 0 {
            return 0;
        }
        filetime_100ns(k) + filetime_100ns(u)
    }
}

/// CPU time of every process that ever ran in the job (the ffmpeg children).
fn job_cpu_time(job: isize) -> u64 {
    unsafe {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
        let ok = QueryInformationJobObject(
            job as _,
            JobObjectBasicAccountingInformation,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        );
        if ok == 0 {
            return 0;
        }
        (info.TotalUserTime.max(0) as u64) + (info.TotalKernelTime.max(0) as u64)
    }
}

/// Process ids currently inside the job.
fn job_pids(job: isize) -> Vec<u32> {
    unsafe {
        // header: two u32 counters, then the id list; room for 64 ids
        let mut buf = vec![0usize; 2 + 64];
        let ok = QueryInformationJobObject(
            job as _,
            JobObjectBasicProcessIdList,
            buf.as_mut_ptr() as *mut c_void,
            (buf.len() * std::mem::size_of::<usize>()) as u32,
            std::ptr::null_mut(),
        );
        if ok == 0 {
            return Vec::new();
        }
        let header = buf.as_ptr() as *const u32;
        let n = (*header.add(1) as usize).min(64);
        let ids = (buf.as_ptr() as *const u8).add(8) as *const usize;
        (0..n).map(|i| *ids.add(i) as u32).collect()
    }
}

struct Gpu {
    query: isize,
    counter: isize,
}

impl Gpu {
    fn new() -> Option<Gpu> {
        unsafe {
            let mut query = 0isize;
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                return None;
            }
            let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0".encode_utf16().collect();
            let mut counter = 0isize;
            if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) != 0 {
                PdhCloseQuery(query);
                return None;
            }
            PdhCollectQueryData(query);
            Some(Gpu { query, counter })
        }
    }

    /// Highest engine-type utilisation (3D, copy, video encode...) summed over `pids`, in percent.
    fn sample(&self, pids: &[u32]) -> Option<f32> {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return None;
            }
            let (mut size, mut count) = (0u32, 0u32);
            let st = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut());
            if st != PDH_MORE_DATA || size == 0 {
                return None;
            }
            let mut buf = vec![0u64; (size as usize + 7) / 8];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, items) != 0 {
                return None;
            }
            let mut by_type: Vec<(String, f64)> = Vec::new();
            for i in 0..count as usize {
                let it = &*items.add(i);
                let mut len = 0;
                while *it.szName.add(len) != 0 {
                    len += 1;
                }
                let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.szName, len));
                let Some(rest) = name.strip_prefix("pid_") else { continue };
                let pid: u32 = rest.split('_').next().and_then(|p| p.parse().ok()).unwrap_or(0);
                if !pids.contains(&pid) {
                    continue;
                }
                let ty = name.rsplit("engtype_").next().unwrap_or("").to_string();
                let v = it.FmtValue.Anonymous.doubleValue;
                match by_type.iter_mut().find(|(t, _)| *t == ty) {
                    Some((_, sum)) => *sum += v,
                    None => by_type.push((ty, v)),
                }
            }
            Some(by_type.iter().map(|(_, v)| *v).fold(0.0, f64::max).min(100.0) as f32)
        }
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

/// Starts the sampling thread (it ends with the process).
pub fn start(shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let cores = unsafe {
            let mut si: SYSTEM_INFO = std::mem::zeroed();
            GetSystemInfo(&mut si);
            si.dwNumberOfProcessors.max(1) as f64
        };
        let gpu = Gpu::new();
        let own_pid = unsafe { GetCurrentProcessId() };
        let job = shared.job.as_ref().map(|j| j.raw());
        let mut last_cpu = own_cpu_time() + job.map_or(0, job_cpu_time);
        let mut last_at = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = Instant::now();
            let cpu = own_cpu_time() + job.map_or(0, job_cpu_time);
            let wall = now.duration_since(last_at).as_secs_f64() * 1e7; // 100 ns ticks
            if wall > 0.0 && cpu >= last_cpu {
                let pct = ((cpu - last_cpu) as f64 / wall / cores * 100.0).clamp(0.0, 100.0);
                shared.cpu_x10.store((pct * 10.0) as u32, Ordering::Relaxed);
            }
            last_cpu = cpu;
            last_at = now;

            let g = gpu.as_ref().and_then(|g| {
                let mut pids = vec![own_pid];
                if let Some(j) = job {
                    pids.extend(job_pids(j));
                }
                g.sample(&pids)
            });
            shared.gpu_x10.store(g.map_or(-1, |v| (v * 10.0) as i32), Ordering::Relaxed);
        }
    });
}
