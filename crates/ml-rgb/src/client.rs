//! Blocking client for a running OpenRGB server on 127.0.0.1:6742.

use crate::proto::{self, Device};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const PORT: u16 = 6742;

pub struct Client {
    s: TcpStream,
    /// packet being built for the next frame (kept, so streaming does not allocate)
    buf: Vec<u8>,
}

impl Client {
    pub fn connect() -> Result<Client, String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
        let s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
        s.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
        s.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut c = Client { s, buf: Vec::with_capacity(4096) };
        c.send(0, proto::SET_NAME, b"Buffer\0")?;
        c.send(0, proto::REQ_PROTOCOL, &proto::PROTOCOL.to_le_bytes())?;
        c.reply(proto::REQ_PROTOCOL)?;
        Ok(c)
    }

    fn send(&mut self, dev: u32, id: u32, payload: &[u8]) -> Result<(), String> {
        self.s.write_all(&proto::frame(dev, id, payload)).map_err(|e| e.to_string())
    }

    /// The next reply with packet id `id`; the server also pushes packets nobody asked for (device list updated).
    fn reply(&mut self, id: u32) -> Result<Vec<u8>, String> {
        loop {
            let mut h = [0u8; 16];
            self.s.read_exact(&mut h).map_err(|e| e.to_string())?;
            let (_, pid, size) = proto::header(&h)?;
            if size > 1 << 22 {
                return Err("implausible packet size".into());
            }
            let mut body = vec![0u8; size as usize];
            self.s.read_exact(&mut body).map_err(|e| e.to_string())?;
            if pid == id {
                return Ok(body);
            }
        }
    }

    pub fn device_count(&mut self) -> Result<u32, String> {
        self.send(0, proto::REQ_COUNT, &[])?;
        let b = self.reply(proto::REQ_COUNT)?;
        Ok(u32::from_le_bytes(b.get(..4).ok_or("short reply")?.try_into().unwrap()))
    }

    pub fn device(&mut self, index: u32) -> Result<Device, String> {
        self.send(index, proto::REQ_DATA, &proto::PROTOCOL.to_le_bytes())?;
        proto::parse_device(&self.reply(proto::REQ_DATA)?)
    }

    pub fn devices(&mut self) -> Result<Vec<Device>, String> {
        (0..self.device_count()?).map(|i| self.device(i)).collect()
    }

    /// Switches the device to its Direct/Custom mode and shows `colors` (one per LED).
    pub fn set_colors(&mut self, index: u32, colors: &[[u8; 3]]) -> Result<(), String> {
        self.send(index, proto::SET_CUSTOM_MODE, &[])?;
        self.send(index, proto::UPDATE_LEDS, &proto::leds_payload(colors))
    }

    /// Streams a frame without touching the mode (the device is already in Direct mode).
    pub fn frame(&mut self, index: u32, colors: &[[u8; 3]]) -> Result<(), String> {
        proto::write_leds_frame(&mut self.buf, index, colors);
        self.s.write_all(&self.buf).map_err(|e| e.to_string())
    }

    /// Puts a mode (as read earlier) back, e.g. the one a device was in before Buffer took over.
    pub fn restore_mode(&mut self, index: u32, d: &Device) -> Result<(), String> {
        let m = d.modes.get(d.active_mode as usize).ok_or("no such mode")?;
        self.send(index, proto::UPDATE_MODE, &proto::mode_payload(d.active_mode as u32, m))
    }
}
