use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const PIPE_NAME: &str = r"\\.\pipe\xplorer_single_instance_ipc";

pub struct InitialCliPath(pub Mutex<Option<String>>);

/// Extract target folder or file path from CLI arguments, if any.
pub fn parse_cli_target_path() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() <= 1 {
        return None;
    }

    for arg in &args[1..] {
        let trimmed = arg.trim().trim_matches('"');
        if trimmed.starts_with('-') || trimmed.starts_with('/') {
            continue;
        }
        if trimmed.starts_with("shell:") {
            return Some(trimmed.to_string());
        }
        let p = Path::new(trimmed);
        let bytes = trimmed.as_bytes();
        let is_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if p.exists() || is_drive || trimmed.starts_with(r"\\") {
            if let Ok(canon) = std::fs::canonicalize(p) {
                let s = canon.to_string_lossy().to_string();
                // Strip Windows verbatim prefix \\?\ if present
                let clean = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
                return Some(clean);
            }
            return Some(trimmed.to_string());
        }
    }
    None
}



/// Attempt to connect to an existing running instance of Xplorer.
/// If successful, forwards the path and returns `true` (caller should exit).
/// If no instance is listening, returns `false` (caller is the primary instance).
pub fn forward_to_existing_instance(target_path: Option<&str>) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = std::ffi::OsStr::new(PIPE_NAME)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let handle = CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            );

            if let Ok(pipe_handle) = handle {
                if pipe_handle != INVALID_HANDLE_VALUE {
                    let msg = target_path.unwrap_or("").as_bytes();
                    let len_buf = (msg.len() as u32).to_le_bytes();

                    let mut written = 0u32;
                    let _ = windows::Win32::Storage::FileSystem::WriteFile(
                        pipe_handle,
                        Some(&len_buf),
                        Some(&mut written),
                        None,
                    );
                    if !msg.is_empty() {
                        let _ = windows::Win32::Storage::FileSystem::WriteFile(
                            pipe_handle,
                            Some(msg),
                            Some(&mut written),
                            None,
                        );
                    }

                    // Read 1-byte ACK
                    let mut ack = [0u8; 1];
                    let mut read_bytes = 0u32;
                    let _ = windows::Win32::Storage::FileSystem::ReadFile(
                        pipe_handle,
                        Some(&mut ack),
                        Some(&mut read_bytes),
                        None,
                    );

                    let _ = CloseHandle(pipe_handle);
                    return true;
                }
            }
        }
    }
    false
}

/// Spawns the single-instance Named Pipe server in the background.
pub fn start_single_instance_listener(app_handle: tauri::AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = std::ffi::OsStr::new(PIPE_NAME)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        loop {
            unsafe {
                let pipe = CreateNamedPipeW(
                    PCWSTR(wide.as_ptr()),
                    FILE_FLAGS_AND_ATTRIBUTES(0x00000003),
                    windows::Win32::System::Pipes::NAMED_PIPE_MODE(
                        PIPE_TYPE_MESSAGE.0 | PIPE_READMODE_MESSAGE.0 | PIPE_WAIT.0,
                    ),
                    PIPE_UNLIMITED_INSTANCES,
                    4096,
                    4096,
                    0,
                    None,
                );

                if pipe == INVALID_HANDLE_VALUE {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue;
                }

                let connected = ConnectNamedPipe(pipe, None);
                let is_ok = match connected {
                    Ok(_) => true,
                    Err(e) => {
                        // ERROR_PIPE_CONNECTED = 535
                        e.code().0 as u32 == 0x80070217 || e.code().0 == 535
                    }
                };

                if is_ok {
                    let mut len_buf = [0u8; 4];
                    let mut read_bytes = 0u32;
                    let ok_len = windows::Win32::Storage::FileSystem::ReadFile(
                        pipe,
                        Some(&mut len_buf),
                        Some(&mut read_bytes),
                        None,
                    );

                    if ok_len.is_ok() && read_bytes == 4 {
                        let len = u32::from_le_bytes(len_buf) as usize;
                        let mut msg_buf = vec![0u8; len];
                        if len > 0 {
                            let _ = windows::Win32::Storage::FileSystem::ReadFile(
                                pipe,
                                Some(&mut msg_buf),
                                Some(&mut read_bytes),
                                None,
                            );
                        }

                        let path_str = String::from_utf8_lossy(&msg_buf).trim().to_string();

                        // Focus window and emit event
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }

                        if !path_str.is_empty() {
                            let _ = app_handle.emit("open-path-external", path_str);
                        } else {
                            let _ = app_handle.emit("open-path-external", "");
                        }

                        // Send 1-byte ACK
                        let ack = [1u8];
                        let mut written = 0u32;
                        let _ = windows::Win32::Storage::FileSystem::WriteFile(
                            pipe,
                            Some(&ack),
                            Some(&mut written),
                            None,
                        );
                    }
                }

                let _ = DisconnectNamedPipe(pipe);
                let _ = CloseHandle(pipe);
            }
        }
    });
}

#[tauri::command]
pub fn get_initial_launch_path(state: tauri::State<'_, InitialCliPath>) -> Option<String> {
    state.0.lock().ok()?.clone()
}
