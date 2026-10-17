//! Fan control for Buffer. The sensors and PWM outputs come from `buffer-fans.exe` (LibreHardwareMonitor, a helper that is
//! installed on request, see `install`); this crate holds the pure parts: the setup (`model`), the curve engine
//! (`curve`) and the pipe client (`client`). Keys are LibreHardwareMonitor identifiers, never list positions.

pub mod client;
pub mod curve;
pub mod discover;
pub mod import;
pub mod install;
pub mod model;
pub mod pair;
