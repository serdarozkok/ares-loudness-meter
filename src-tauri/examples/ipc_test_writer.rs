//! Example test writer for the `Local\LoudmeterIPCBuffer` shared-memory DAW bridge.
//! Run with: `cargo run --example ipc_test_writer`

use loudmeter_lib::ipc_bridge::{IpcSharedBuffer, IPC_MAGIC, IPC_MAP_NAME, IPC_RING_FRAMES, IPC_VERSION};
use std::f64::consts::PI;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
fn main() {
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
        .expect("CreateFileMappingA failed");
        let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size as usize);
        let buf = &mut *(view.Value as *mut IpcSharedBuffer);

        let fs = 48_000u32;
        buf.sample_rate.store(fs, Ordering::Release);
        buf.channels.store(2, Ordering::Release);
        buf.version.store(IPC_VERSION, Ordering::Release);
        buf.magic.store(IPC_MAGIC, Ordering::Release);

        println!("Writing 48 kHz test tone to Local\\LoudmeterIPCBuffer (Ctrl+C to stop)...");
        let mut pos = buf.write_pos.load(Ordering::Relaxed);
        let block = 480usize; // 10 ms
        let amp = 10f64.powf(-14.0 / 20.0) as f32;
        loop {
            for i in 0..block {
                let t = (pos as usize + i) as f64 / fs as f64;
                let s = ((2.0 * PI * 997.0 * t).sin() as f32) * amp;
                let idx = ((pos as usize + i) & (IPC_RING_FRAMES - 1)) * 2;
                buf.samples[idx] = s;
                buf.samples[idx + 1] = s;
            }
            pos += block as u64;
            buf.write_pos.store(pos, Ordering::Release);
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(not(windows))]
fn main() {}
