//! Named Shared-Memory IPC Bridge (`Local\LoudmeterIPCBuffer`) for ASIO DAWs.
//!
//! When a user runs their DAW in hardware-exclusive ASIO mode (bypassing the
//! Windows WASAPI audio engine), a lightweight VST3/CLAP companion plugin or
//! external sender writes interleaved stereo `f32` frames into the lock-free
//! ring buffer located at `Local\LoudmeterIPCBuffer`.
//!
//! Memory layout (131,104 bytes total):
//!  * `0x00`: `magic`       (`u32` = `0x4C4D_5052` "LMPR")
//!  * `0x04`: `version`     (`u32` = `1`)
//!  * `0x08`: `sample_rate` (`AtomicU32`, e.g., `48000`)
//!  * `0x0C`: `channels`    (`AtomicU32` = `2`)
//!  * `0x10`: `write_pos`   (`AtomicU64`, monotonic stereo frame counter)
//!  * `0x18`: `reserved`    (`u64` padding to 32-byte header)
//!  * `0x20`: `samples`     (`[f32; 16384 * 2]` interleaved stereo ring)

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const IPC_MAP_NAME: &str = "Local\\LoudmeterIPCBuffer\0";
pub const IPC_MAGIC: u32 = 0x4C4D_5052; // "LMPR"
pub const IPC_VERSION: u32 = 1;
pub const IPC_RING_FRAMES: usize = 16_384;

#[repr(C)]
pub struct IpcSharedBuffer {
    pub magic: AtomicU32,
    pub version: AtomicU32,
    pub sample_rate: AtomicU32,
    pub channels: AtomicU32,
    pub write_pos: AtomicU64,
    pub reserved: u64,
    pub samples: [f32; IPC_RING_FRAMES * 2],
}

#[cfg(windows)]
pub struct IpcBridgeReader {
    handle: windows::Win32::Foundation::HANDLE,
    ptr: *mut IpcSharedBuffer,
    read_pos: u64,
}

#[cfg(windows)]
unsafe impl Send for IpcBridgeReader {}

#[cfg(windows)]
impl IpcBridgeReader {
    pub fn open_or_create() -> Result<Self, String> {
        use windows::core::PCSTR;
        use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows::Win32::System::Memory::{
            CreateFileMappingA, MapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
        };

        unsafe {
            let size = std::mem::size_of::<IpcSharedBuffer>() as u32;
            let handle = CreateFileMappingA(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                size,
                PCSTR(IPC_MAP_NAME.as_ptr()),
            )
            .map_err(|e| format!("CreateFileMappingA failed: {e}"))?;

            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size as usize);
            if view.Value.is_null() {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                return Err("MapViewOfFile returned null".to_string());
            }

            let ptr = view.Value as *mut IpcSharedBuffer;
            let buf = &*ptr;
            if buf.magic.load(Ordering::Acquire) != IPC_MAGIC {
                buf.sample_rate.store(48_000, Ordering::Release);
                buf.channels.store(2, Ordering::Release);
                buf.write_pos.store(0, Ordering::Release);
                buf.version.store(IPC_VERSION, Ordering::Release);
                buf.magic.store(IPC_MAGIC, Ordering::Release);
            }
            let read_pos = buf.write_pos.load(Ordering::Acquire);
            Ok(Self { handle, ptr, read_pos })
        }
    }

    pub fn sample_rate(&self) -> u32 {
        unsafe { (*self.ptr).sample_rate.load(Ordering::Relaxed).max(8_000) }
    }

    /// Reads newly available interleaved stereo samples into `out`.
    pub fn read_available(&mut self, out: &mut Vec<f32>) -> usize {
        unsafe {
            let buf = &*self.ptr;
            if buf.magic.load(Ordering::Acquire) != IPC_MAGIC {
                return 0;
            }
            let write_pos = buf.write_pos.load(Ordering::Acquire);
            if write_pos <= self.read_pos {
                return 0;
            }
            let available = (write_pos - self.read_pos) as usize;
            if available > IPC_RING_FRAMES {
                // Writer lapped us; skip ahead to the most recent half-ring.
                self.read_pos = write_pos - (IPC_RING_FRAMES as u64 / 2);
            }
            let count = (write_pos - self.read_pos) as usize;
            out.reserve(count * 2);
            for i in 0..count {
                let idx = ((self.read_pos as usize + i) & (IPC_RING_FRAMES - 1)) * 2;
                out.push(buf.samples[idx]);
                out.push(buf.samples[idx + 1]);
            }
            self.read_pos = write_pos;
            count
        }
    }
}

#[cfg(windows)]
impl Drop for IpcBridgeReader {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Memory::{UnmapViewOfFile, MEMORY_MAPPED_VIEW_ADDRESS};
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr as *mut _ });
            let _ = CloseHandle(self.handle);
        }
    }
}
