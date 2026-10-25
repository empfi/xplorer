use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, Emitter, State};

pub struct FolderWatcherState {
    inner: Arc<Mutex<WatcherInner>>,
}

impl Default for FolderWatcherState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatcherInner {
                current_path: None,
                stop_signal: None,
                worker: None,
            })),
        }
    }
}

struct WatcherInner {
    current_path: Option<String>,
    stop_signal: Option<Arc<AtomicBool>>,
    worker: Option<JoinHandle<()>>,
}

/// Watch the currently active directory for any external creates, modifies, deletes, renames.
/// Automatically tears down previous watcher and starts watching the new target.
#[tauri::command]
pub fn watch_folder(
    app: AppHandle,
    state: State<'_, FolderWatcherState>,
    path: String,
) -> Result<(), String> {
    let mut norm = path.trim().to_string();
    if norm.len() == 2 && norm.ends_with(':') {
        norm.push('\\');
    } else if norm.len() > 3 && (norm.ends_with('\\') || norm.ends_with('/')) {
        norm.pop();
    }

    let mut inner = state.inner.lock().unwrap();

    // If already watching this exact path, keep watching.
    if inner.current_path.as_deref() == Some(&norm) {
        return Ok(());
    }

    // Stop current watcher if running
    if let Some(stop) = inner.stop_signal.take() {
        stop.store(true, Ordering::Relaxed);
    }
    inner.worker = None;
    inner.current_path = None;

    // Do not watch virtual paths or empty paths
    if norm.is_empty() || norm.starts_with("shell:") || norm.starts_with("upnp::") {
        return Ok(());
    }

    let target_path = norm.clone();
    let stop_signal = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop_signal);

    let handle = thread::spawn(move || {
        #[cfg(windows)]
        {
            use windows::core::HSTRING;
            use windows::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
            use windows::Win32::Storage::FileSystem::{
                FindCloseChangeNotification, FindFirstChangeNotificationW,
                FindNextChangeNotification, FILE_NOTIFY_CHANGE_DIR_NAME,
                FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
                FILE_NOTIFY_CHANGE_SIZE,
            };
            use windows::Win32::System::Threading::WaitForSingleObject;

            let wide = HSTRING::from(&target_path);
            let notif_handle = unsafe {
                FindFirstChangeNotificationW(
                    &wide,
                    false, // Watch immediate folder only
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_DIR_NAME
                        | FILE_NOTIFY_CHANGE_LAST_WRITE
                        | FILE_NOTIFY_CHANGE_SIZE,
                )
            };

            if let Ok(h) = notif_handle {
                if h != INVALID_HANDLE_VALUE {
                    while !stop_clone.load(Ordering::Relaxed) {
                        // Poll with 300ms timeout so thread responds cleanly to exit signals
                        let wait_res = unsafe { WaitForSingleObject(h, 300) };
                        if wait_res == WAIT_OBJECT_0 {
                            // Debounce rapid bursts (e.g. streaming file download, multi-file extract)
                            thread::sleep(std::time::Duration::from_millis(150));
                            let _ = unsafe { FindNextChangeNotification(h) };

                            if !stop_clone.load(Ordering::Relaxed) {
                                let _ = app.emit("folder-changed", &target_path);
                            }
                        }
                    }
                    unsafe {
                        let _ = FindCloseChangeNotification(h);
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (target_path, app, stop_clone);
        }
    });

    inner.current_path = Some(norm);
    inner.stop_signal = Some(stop_signal);
    inner.worker = Some(handle);

    Ok(())
}
