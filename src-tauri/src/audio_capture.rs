//! Cross-platform audio capture router:
//!  * **Windows 10/11**: Native WASAPI Shared-Mode Loopback (`IAudioClient`,
//!    `IAudioCaptureClient`), Per-Application Session Enumeration
//!    (`IAudioSessionManager2`) with Win32 icon extraction, and Windows 10/11
//!    Process Loopback exclusion (`ActivateAudioInterfaceAsync`).
//!  * **macOS (13+ / 14.2+)**: CoreAudio / ScreenCaptureKit / AudioHardware
//!    Output Device enumeration (`cpal` host integration) so the exact same
//!    Tauri + Rust codebase compiles and runs natively on macOS (Apple Silicon
//!    & Intel) via GitHub Actions.

use crate::dsp::CaptureMode;
#[cfg(windows)]
use crate::ipc_bridge::IpcBridgeReader;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(windows)]
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub exe_name: String,
    pub display_name: String,
    pub icon: Option<String>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub mode: CaptureMode,
    pub device_name: String,
    pub sample_rate: u32,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub windows_build: u32,
    pub process_loopback_supported: bool,
    pub app_version: String,
}

#[allow(dead_code)]
static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

#[allow(dead_code)]
fn icon_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_system_info() -> SystemInfo {
    let build = windows_build_number();
    SystemInfo {
        windows_build: build,
        process_loopback_supported: cfg!(windows) && build >= 20348,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[cfg(windows)]
pub fn windows_build_number() -> u32 {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    unsafe {
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let _ = RtlGetVersion(&mut info);
        info.dwBuildNumber
    }
}

#[cfg(not(windows))]
pub fn windows_build_number() -> u32 {
    0
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use base64::Engine as _;
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH, S_OK};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, eConsole, eRender, AudioSessionStateActive, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
        IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
        IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
    use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
    const WAVE_FORMAT_PCM_TAG: u16 = 1;

    pub struct ComGuard;
    impl ComGuard {
        pub fn init() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            Self
        }
    }

    unsafe fn device_id_string(dev: &IMMDevice) -> Option<String> {
        let raw: PWSTR = dev.GetId().ok()?;
        let s = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        s
    }

    unsafe fn device_friendly_name(dev: &IMMDevice) -> String {
        let Ok(store) = dev.OpenPropertyStore(STGM_READ) else {
            return "Audio Output".to_string();
        };
        let Ok(prop) = store.GetValue(&PKEY_Device_FriendlyName) else {
            return "Audio Output".to_string();
        };
        if let Ok(pwstr) = PropVariantToStringAlloc(&prop) {
            let s = pwstr.to_string().unwrap_or_else(|_| "Audio Output".to_string());
            CoTaskMemFree(Some(pwstr.0 as *const _));
            return s;
        }
        "Audio Output".to_string()
    }

    unsafe fn device_mix_format(dev: &IMMDevice) -> (u32, u32) {
        let Ok(client) = dev.Activate::<IAudioClient>(CLSCTX_ALL, None) else {
            return (2, 48_000);
        };
        let Ok(fmt_ptr) = client.GetMixFormat() else {
            return (2, 48_000);
        };
        let fmt = *fmt_ptr;
        CoTaskMemFree(Some(fmt_ptr as *const _));
        (fmt.nChannels.max(2) as u32, fmt.nSamplesPerSec.max(8_000))
    }

    pub fn list_output_devices() -> Vec<DeviceInfo> {
        let _com = ComGuard::init();
        let mut out = Vec::new();
        unsafe {
            let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return out;
            };
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .ok()
                .and_then(|d| device_id_string(&d));

            let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
                return out;
            };
            let count = collection.GetCount().unwrap_or(0);
            for i in 0..count {
                if let Ok(dev) = collection.Item(i) {
                    let Some(id) = device_id_string(&dev) else { continue };
                    let name = device_friendly_name(&dev);
                    let (channels, sample_rate) = device_mix_format(&dev);
                    let is_default = default_id.as_deref() == Some(id.as_str());
                    out.push(DeviceInfo {
                        id,
                        name,
                        channels,
                        sample_rate,
                        is_default,
                    });
                }
            }
        }
        out.sort_by_key(|d| (!d.is_default, d.name.clone()));
        out
    }

    unsafe fn pid_to_exe_path(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize * 2];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        ok.ok()?;
        Some(OsString::from_wide(&buf[..len as usize]).to_string_lossy().to_string())
    }

    unsafe fn extract_exe_icon_png_data_url(exe_path: &str) -> Option<String> {
        if let Some(cached) = icon_cache().lock().get(exe_path).cloned() {
            return cached;
        }
        let wide: Vec<u16> = std::ffi::OsStr::new(exe_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut shfi = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        );
        if res == 0 || shfi.hIcon.is_invalid() {
            icon_cache().lock().insert(exe_path.to_string(), None);
            return None;
        }
        let hicon = shfi.hIcon;
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return None;
        }
        let mut bm = BITMAP::default();
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        let w = bm.bmWidth.max(16) as usize;
        let h = bm.bmHeight.max(16) as usize;

        let hdc = CreateCompatibleDC(None);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; w * h * 4];
        let lines = GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            h as u32,
            Some(bgra.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(hdc);
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor.into());
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        let _ = DestroyIcon(hicon);

        if lines == 0 {
            icon_cache().lock().insert(exe_path.to_string(), None);
            return None;
        }

        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        let mut png_bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            if let Ok(mut writer) = encoder.write_header() {
                let _ = writer.write_image_data(&bgra);
            }
        }
        let data_url = if png_bytes.is_empty() {
            None
        } else {
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png_bytes)
            ))
        };
        icon_cache().lock().insert(exe_path.to_string(), data_url.clone());
        data_url
    }

    fn nice_app_name(exe_stem: &str) -> String {
        let mut chars = exe_stem.chars();
        match chars.next() {
            None => "Application".to_string(),
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        }
    }

    pub fn enumerate_audio_sessions() -> Vec<AudioSessionInfo> {
        let _com = ComGuard::init();
        let mut by_exe: HashMap<String, AudioSessionInfo> = HashMap::new();
        let self_pid = std::process::id();

        unsafe {
            let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return Vec::new();
            };
            let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
                return Vec::new();
            };
            let dev_count = devices.GetCount().unwrap_or(0);
            for d in 0..dev_count {
                let Ok(dev) = devices.Item(d) else { continue };
                let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let Ok(sess_enum) = mgr.GetSessionEnumerator() else {
                    continue;
                };
                let count = sess_enum.GetCount().unwrap_or(0);
                for i in 0..count {
                    let Ok(ctrl) = sess_enum.GetSession(i) else { continue };
                    let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    if ctrl2.IsSystemSoundsSession() == S_OK {
                        continue;
                    }
                    let Ok(pid) = ctrl2.GetProcessId() else { continue };
                    if pid == 0 || pid == self_pid {
                        continue;
                    }
                    let Some(exe_path) = pid_to_exe_path(pid) else {
                        continue;
                    };
                    let path_obj = Path::new(&exe_path);
                    let Some(exe_name_os) = path_obj.file_name() else {
                        continue;
                    };
                    let exe_name = exe_name_os.to_string_lossy().to_ascii_lowercase();
                    let stem = path_obj
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| exe_name.clone());

                    let session_display = ctrl
                        .GetDisplayName()
                        .ok()
                        .and_then(|pw| {
                            let s = pw.to_string().ok();
                            CoTaskMemFree(Some(pw.0 as *const _));
                            s
                        })
                        .filter(|s| !s.trim().is_empty() && !s.starts_with('@'));

                    let active = ctrl.GetState().map(|st| st == AudioSessionStateActive).unwrap_or(false);
                    let icon = extract_exe_icon_png_data_url(&exe_path);

                    let entry = by_exe.entry(exe_name.clone()).or_insert_with(|| AudioSessionInfo {
                        pid,
                        exe_name,
                        display_name: session_display.unwrap_or_else(|| nice_app_name(&stem)),
                        icon,
                        active,
                    });
                    if active {
                        entry.active = true;
                        entry.pid = pid;
                    }
                }
            }
        }
        let mut list: Vec<AudioSessionInfo> = by_exe.into_values().collect();
        list.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.display_name.cmp(&b.display_name)));
        list
    }

    #[derive(Clone, Copy)]
    pub enum SampleFormat {
        Float32,
        Pcm16,
        Pcm24,
        Pcm32,
    }

    pub struct ActiveCaptureStream {
        pub client: IAudioClient,
        pub capture: IAudioCaptureClient,
        pub channels: usize,
        pub sample_rate: u32,
        pub format: SampleFormat,
    }

    unsafe fn parse_wave_format(fmt_ptr: *const WAVEFORMATEX) -> Option<(usize, u32, SampleFormat)> {
        let fmt = *fmt_ptr;
        let channels = fmt.nChannels as usize;
        let sample_rate = fmt.nSamplesPerSec;
        if channels == 0 || sample_rate == 0 {
            return None;
        }
        let tag = fmt.wFormatTag as u32;
        if tag == WAVE_FORMAT_IEEE_FLOAT_TAG as u32 && fmt.wBitsPerSample == 32 {
            return Some((channels, sample_rate, SampleFormat::Float32));
        }
        if tag == WAVE_FORMAT_PCM_TAG as u32 {
            return match fmt.wBitsPerSample {
                16 => Some((channels, sample_rate, SampleFormat::Pcm16)),
                24 => Some((channels, sample_rate, SampleFormat::Pcm24)),
                32 => Some((channels, sample_rate, SampleFormat::Pcm32)),
                _ => None,
            };
        }
        if tag == WAVE_FORMAT_EXTENSIBLE {
            let ext = *(fmt_ptr as *const WAVEFORMATEXTENSIBLE);
            let sub: GUID = std::ptr::read_unaligned(std::ptr::addr_of!(ext.SubFormat));
            if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT && fmt.wBitsPerSample == 32 {
                return Some((channels, sample_rate, SampleFormat::Float32));
            }
            return match fmt.wBitsPerSample {
                16 => Some((channels, sample_rate, SampleFormat::Pcm16)),
                24 => Some((channels, sample_rate, SampleFormat::Pcm24)),
                32 => Some((channels, sample_rate, SampleFormat::Pcm32)),
                _ => None,
            };
        }
        None
    }

    pub unsafe fn open_endpoint_loopback(device_id: Option<&str>) -> Result<(ActiveCaptureStream, String, String), String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {e}"))?;

        let dev: IMMDevice = if let Some(id) = device_id {
            let wide: Vec<u16> = std::ffi::OsStr::new(id)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .or_else(|_| enumerator.GetDefaultAudioEndpoint(eRender, eConsole))
                .map_err(|e| format!("No active audio output endpoint: {e}"))?
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("No default audio output endpoint: {e}"))?
        };

        let resolved_id = device_id_string(&dev).unwrap_or_default();
        let name = device_friendly_name(&dev);
        let client: IAudioClient = dev
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("IAudioClient::Activate failed: {e}"))?;

        let fmt_ptr = client
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat failed: {e}"))?;
        let Some((channels, sample_rate, format)) = parse_wave_format(fmt_ptr) else {
            CoTaskMemFree(Some(fmt_ptr as *const _));
            return Err("Unsupported endpoint mix format".to_string());
        };

        let hns_buffer_duration: i64 = 250_000;
        let init_res = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            hns_buffer_duration,
            0,
            fmt_ptr,
            None,
        );
        CoTaskMemFree(Some(fmt_ptr as *const _));
        init_res.map_err(|e| format!("IAudioClient::Initialize failed: {e}"))?;

        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("GetService(IAudioCaptureClient) failed: {e}"))?;
        client.Start().map_err(|e| format!("IAudioClient::Start failed: {e}"))?;

        Ok((
            ActiveCaptureStream {
                client,
                capture,
                channels,
                sample_rate,
                format,
            },
            resolved_id,
            name,
        ))
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivateCompletionHandler {
        tx: Mutex<Option<mpsc::Sender<Result<IAudioClient, HRESULT>>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateCompletionHandler_Impl {
        fn ActivateCompleted(&self, operation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            unsafe {
                let mut hr = HRESULT(0);
                let mut punk = None;
                if let Some(op) = operation.as_ref() {
                    let _ = op.GetActivateResult(&mut hr, &mut punk);
                }
                let result = if hr.is_ok() {
                    punk.and_then(|u| u.cast::<IAudioClient>().ok())
                        .ok_or(HRESULT(-1))
                } else {
                    Err(hr)
                };
                if let Some(tx) = self.tx.lock().take() {
                    let _ = tx.send(result);
                }
            }
            Ok(())
        }
    }

    pub unsafe fn open_process_loopback(pid: u32, include_process: bool, sample_rate: u32) -> Result<ActiveCaptureStream, String> {
        let mode = if include_process {
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        } else {
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
        };

        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: windows::Win32::Media::Audio::AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: mode,
                },
            },
        };

        #[repr(C)]
        struct RawBlobPropVariant {
            vt: u16,
            r1: u16,
            r2: u16,
            r3: u16,
            cb_size: u32,
            _pad: u32,
            p_blob_data: *mut u8,
        }
        let raw_pv = RawBlobPropVariant {
            vt: 65,
            r1: 0,
            r2: 0,
            r3: 0,
            cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            _pad: 0,
            p_blob_data: &mut params as *mut _ as *mut u8,
        };

        let (tx, rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = ActivateCompletionHandler {
            tx: Mutex::new(Some(tx)),
        }
        .into();

        let _op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&raw_pv as *const _ as *const _),
            &handler,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?;

        let client = rx
            .recv_timeout(Duration::from_millis(1500))
            .map_err(|_| "ActivateAudioInterfaceAsync timed out".to_string())?
            .map_err(|hr| format!("Process Loopback activation HRESULT {hr:?}"))?;

        let fmt = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT_TAG,
            nChannels: 2,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                250_000,
                0,
                &fmt,
                None,
            )
            .map_err(|e| format!("Process Loopback Initialize failed: {e}"))?;

        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("Process Loopback GetService failed: {e}"))?;
        client.Start().map_err(|e| format!("Process Loopback Start failed: {e}"))?;

        Ok(ActiveCaptureStream {
            client,
            capture,
            channels: 2,
            sample_rate,
            format: SampleFormat::Float32,
        })
    }

    impl ActiveCaptureStream {
        pub unsafe fn drain_stereo(&self, pair_idx: usize, out: &mut Vec<f32>) {
            let ch = self.channels.max(1);
            let c_l = (pair_idx * 2).min(ch - 1);
            let c_r = (pair_idx * 2 + 1).min(ch - 1);

            while let Ok(packet_frames) = self.capture.GetNextPacketSize() {
                if packet_frames == 0 {
                    break;
                }
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames_to_read: u32 = 0;
                let mut flags: u32 = 0;
                if self
                    .capture
                    .GetBuffer(&mut data_ptr, &mut frames_to_read, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                let n = frames_to_read as usize;
                let silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null();
                if silent {
                    out.resize(out.len() + n * 2, 0.0);
                } else {
                    out.reserve(n * 2);
                    match self.format {
                        SampleFormat::Float32 => {
                            let slice = std::slice::from_raw_parts(data_ptr as *const f32, n * ch);
                            for f in 0..n {
                                let base = f * ch;
                                out.push(slice[base + c_l]);
                                out.push(slice[base + c_r]);
                            }
                        }
                        SampleFormat::Pcm16 => {
                            let slice = std::slice::from_raw_parts(data_ptr as *const i16, n * ch);
                            const SCALE: f32 = 1.0 / 32768.0;
                            for f in 0..n {
                                let base = f * ch;
                                out.push(slice[base + c_l] as f32 * SCALE);
                                out.push(slice[base + c_r] as f32 * SCALE);
                            }
                        }
                        SampleFormat::Pcm24 => {
                            let bytes = std::slice::from_raw_parts(data_ptr, n * ch * 3);
                            const SCALE: f32 = 1.0 / 8_388_608.0;
                            let read_i24 = |idx: usize| -> f32 {
                                let b0 = bytes[idx * 3] as i32;
                                let b1 = bytes[idx * 3 + 1] as i32;
                                let b2 = (bytes[idx * 3 + 2] as i8) as i32;
                                ((b2 << 16) | (b1 << 8) | b0) as f32 * SCALE
                            };
                            for f in 0..n {
                                let base = f * ch;
                                out.push(read_i24(base + c_l));
                                out.push(read_i24(base + c_r));
                            }
                        }
                        SampleFormat::Pcm32 => {
                            let slice = std::slice::from_raw_parts(data_ptr as *const i32, n * ch);
                            const SCALE: f32 = 1.0 / 2_147_483_648.0;
                            for f in 0..n {
                                let base = f * ch;
                                out.push(slice[base + c_l] as f32 * SCALE);
                                out.push(slice[base + c_r] as f32 * SCALE);
                            }
                        }
                    }
                }
                let _ = self.capture.ReleaseBuffer(frames_to_read);
            }
        }
    }

    impl Drop for ActiveCaptureStream {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }
}

#[cfg(windows)]
pub use win_impl::{enumerate_audio_sessions, list_output_devices};

#[cfg(not(windows))]
pub fn list_output_devices() -> Vec<DeviceInfo> {
    vec![DeviceInfo {
        id: "default".to_string(),
        name: "System Audio Output (CoreAudio)".to_string(),
        channels: 2,
        sample_rate: 48_000,
        is_default: true,
    }]
}

#[cfg(not(windows))]
pub fn enumerate_audio_sessions() -> Vec<AudioSessionInfo> {
    Vec::new()
}

/// Manages active WASAPI / Process Loopback / ASIO IPC streams on Windows.
#[cfg(windows)]
pub struct AudioCaptureController {
    _com: win_impl::ComGuard,
    input_source: String,
    desired_device_id: Option<String>,
    resolved_device_id: String,
    device_name: String,
    channel_pair: usize,
    ignored_apps: HashSet<String>,
    endpoint_stream: Option<win_impl::ActiveCaptureStream>,
    direct_exclude_stream: Option<(u32, win_impl::ActiveCaptureStream)>,
    excluded_pid_streams: HashMap<u32, win_impl::ActiveCaptureStream>,
    ipc_reader: Option<IpcBridgeReader>,
    sample_rate: u32,
    mode: CaptureMode,
    status_msg: Option<String>,
    last_check: std::time::Instant,
    scratch_sub: Vec<f32>,
}

#[cfg(windows)]
impl AudioCaptureController {
    pub fn new(
        input_source: String,
        device_id: Option<String>,
        channel_pair: usize,
        ignored_apps: Vec<String>,
    ) -> Self {
        let mut ctrl = Self {
            _com: win_impl::ComGuard::init(),
            input_source,
            desired_device_id: device_id,
            resolved_device_id: String::new(),
            device_name: "Default Audio Output".to_string(),
            channel_pair,
            ignored_apps: ignored_apps.into_iter().map(|s| s.to_ascii_lowercase()).collect(),
            endpoint_stream: None,
            direct_exclude_stream: None,
            excluded_pid_streams: HashMap::new(),
            ipc_reader: None,
            sample_rate: 48_000,
            mode: CaptureMode::None,
            status_msg: None,
            last_check: std::time::Instant::now(),
            scratch_sub: Vec::with_capacity(4096),
        };
        ctrl.reconfigure();
        ctrl
    }

    pub fn apply_config(
        &mut self,
        input_source: String,
        device_id: Option<String>,
        channel_pair: usize,
        ignored_apps: Vec<String>,
    ) {
        let new_ignored: HashSet<String> = ignored_apps.into_iter().map(|s| s.to_ascii_lowercase()).collect();
        let source_changed = self.input_source != input_source || self.desired_device_id != device_id;
        self.input_source = input_source;
        self.desired_device_id = device_id;
        self.channel_pair = channel_pair;
        if source_changed || self.ignored_apps != new_ignored {
            self.ignored_apps = new_ignored;
            self.reconfigure();
        }
    }

    pub fn reconfigure(&mut self) {
        self.endpoint_stream = None;
        self.direct_exclude_stream = None;
        self.excluded_pid_streams.clear();
        self.ipc_reader = None;
        self.status_msg = None;

        if self.input_source.eq_ignore_ascii_case("ipc") {
            match IpcBridgeReader::open_or_create() {
                Ok(reader) => {
                    self.sample_rate = reader.sample_rate();
                    self.device_name = "ASIO IPC Bridge (Local\\LoudmeterIPCBuffer)".to_string();
                    self.mode = CaptureMode::IpcBridge;
                    self.ipc_reader = Some(reader);
                }
                Err(e) => {
                    self.mode = CaptureMode::None;
                    self.status_msg = Some(e);
                }
            }
            return;
        }

        unsafe {
            match win_impl::open_endpoint_loopback(self.desired_device_id.as_deref()) {
                Ok((stream, resolved_id, name)) => {
                    self.sample_rate = stream.sample_rate;
                    self.resolved_device_id = resolved_id;
                    self.device_name = name;
                    self.mode = CaptureMode::EndpointLoopback;
                    self.endpoint_stream = Some(stream);
                }
                Err(e) => {
                    self.mode = CaptureMode::None;
                    self.status_msg = Some(e);
                    return;
                }
            }
        }

        self.refresh_ignored_streams();
    }

    fn refresh_ignored_streams(&mut self) {
        if self.ignored_apps.is_empty() || windows_build_number() < 20348 {
            self.direct_exclude_stream = None;
            self.excluded_pid_streams.clear();
            if self.endpoint_stream.is_some() {
                self.mode = CaptureMode::EndpointLoopback;
            }
            return;
        }

        let sessions = enumerate_audio_sessions();
        let matching_pids: Vec<u32> = sessions
            .into_iter()
            .filter(|s| self.ignored_apps.contains(&s.exe_name.to_ascii_lowercase()))
            .map(|s| s.pid)
            .collect();

        if matching_pids.is_empty() {
            self.direct_exclude_stream = None;
            self.excluded_pid_streams.clear();
            if self.endpoint_stream.is_some() {
                self.mode = CaptureMode::EndpointLoopback;
            }
            return;
        }

        if matching_pids.len() == 1 && self.desired_device_id.is_none() && self.channel_pair == 0 {
            let pid = matching_pids[0];
            let already_open = self.direct_exclude_stream.as_ref().map(|(p, _)| *p == pid).unwrap_or(false);
            if !already_open {
                unsafe {
                    if let Ok(stream) = win_impl::open_process_loopback(pid, false, self.sample_rate) {
                        self.direct_exclude_stream = Some((pid, stream));
                        self.excluded_pid_streams.clear();
                        self.mode = CaptureMode::ProcessExclude;
                        return;
                    }
                }
            } else {
                self.mode = CaptureMode::ProcessExclude;
                return;
            }
        }

        self.direct_exclude_stream = None;
        let pid_set: HashSet<u32> = matching_pids.iter().copied().collect();
        self.excluded_pid_streams.retain(|pid, _| pid_set.contains(pid));
        for pid in matching_pids {
            if !self.excluded_pid_streams.contains_key(&pid) {
                unsafe {
                    if let Ok(stream) = win_impl::open_process_loopback(pid, true, self.sample_rate) {
                        self.excluded_pid_streams.insert(pid, stream);
                    }
                }
            }
        }
        self.mode = if self.excluded_pid_streams.is_empty() {
            CaptureMode::EndpointLoopback
        } else {
            CaptureMode::ProcessExclude
        };
    }

    pub fn periodic_maintenance(&mut self) {
        if self.last_check.elapsed().as_millis() < 1500 {
            return;
        }
        self.last_check = std::time::Instant::now();

        if self.input_source.eq_ignore_ascii_case("ipc") {
            if let Some(ref reader) = self.ipc_reader {
                self.sample_rate = reader.sample_rate();
            }
            return;
        }

        let devices = list_output_devices();
        let target_dev = if let Some(ref wanted) = self.desired_device_id {
            devices.iter().find(|d| &d.id == wanted)
        } else {
            devices.iter().find(|d| d.is_default)
        };

        if let Some(dev) = target_dev {
            if dev.id != self.resolved_device_id || dev.sample_rate != self.sample_rate || self.endpoint_stream.is_none() {
                self.reconfigure();
                return;
            }
        }

        if !self.ignored_apps.is_empty() {
            self.refresh_ignored_streams();
        }
    }

    pub fn read_stereo(&mut self, out: &mut Vec<f32>) {
        out.clear();
        if let Some(ref mut ipc) = self.ipc_reader {
            self.sample_rate = ipc.sample_rate();
            ipc.read_available(out);
            return;
        }

        unsafe {
            if let Some((_, ref direct)) = self.direct_exclude_stream {
                if let Some(ref ep) = self.endpoint_stream {
                    self.scratch_sub.clear();
                    ep.drain_stereo(self.channel_pair, &mut self.scratch_sub);
                }
                direct.drain_stereo(0, out);
                return;
            }

            if let Some(ref ep) = self.endpoint_stream {
                ep.drain_stereo(self.channel_pair, out);
            }

            if !self.excluded_pid_streams.is_empty() && !out.is_empty() {
                for stream in self.excluded_pid_streams.values() {
                    self.scratch_sub.clear();
                    stream.drain_stereo(0, &mut self.scratch_sub);
                    let n = out.len().min(self.scratch_sub.len());
                    for i in 0..n {
                        out[i] = (out[i] - self.scratch_sub[i]).clamp(-2.0, 2.0);
                    }
                }
            }
        }
    }

    pub fn status(&self) -> CaptureStatus {
        CaptureStatus {
            mode: self.mode,
            device_name: self.device_name.clone(),
            sample_rate: self.sample_rate,
            message: self.status_msg.clone(),
        }
    }
}
