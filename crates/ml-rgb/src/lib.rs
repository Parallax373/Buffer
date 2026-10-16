//! RGB control through OpenRGB's SDK server. OpenRGB is downloaded on the user's request and runs as a separate
//! process; this crate only speaks to its local socket.

pub mod client;
pub mod darkproject;
pub mod engine;
pub mod install;
pub mod proto;
pub mod scene;
