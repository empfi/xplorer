use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State};

/// Progress update emitted during file copy/move/delete operations.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TransferProgress {
    pub op_type: String, // "copy" | "move" | "delete"
    pub source_dir: String,
    pub dest_dir: String,
    pub current_file: String,
    pub files_completed: usize,
    pub total_files: usize,
    pub bytes_copied: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub speed_mbps: f32,
    pub is_move: bool,
    pub is_paused: bool,
    pub done: bool,
    pub canceled: bool,
    pub error: Option<String>,
}

/// Result returned from paste operation for undo/redo support.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PasteResult {
    pub is_cut: bool,
    pub pairs: Vec<(String, String)>,
}

/// Managed state to pause, resume, and cancel active transfers.
pub struct TransferControlState {
    pub cancel_flag: Arc<AtomicBool>,
    pub pause_flag: Arc<AtomicBool>,
}

impl Default for TransferControlState {
    fn default() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
pub fn cancel_transfer(ctrl: State<'_, TransferControlState>) {
    ctrl.cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn pause_transfer(ctrl: State<'_, TransferControlState>) {
    ctrl.pause_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn resume_transfer(ctrl: State<'_, TransferControlState>) {
    ctrl.pause_flag.store(false, Ordering::Relaxed);
}

fn compute_total_bytes(paths: &[PathBuf]) -> (usize, u64) {
    let mut count = 0;
    let mut total = 0;
    for p in paths {
        if let Ok(meta) = fs::metadata(p) {
            if meta.is_dir() {
                if let Ok(rd) = fs::read_dir(p) {
                    let sub_paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                    let (sub_count, sub_bytes) = compute_total_bytes(&sub_paths);
                    count += sub_count;
                    total += sub_bytes;
                }
            } else {
                count += 1;
                total += meta.len();
            }
        }
    }
    (count, total)
}

fn copy_file_with_progress<F>(
    src: &Path,
    dst: &Path,
    cancel_flag: &Arc<AtomicBool>,
    pause_flag: &Arc<AtomicBool>,
    mut on_chunk: F,
) -> std::io::Result<u64>
where
    F: FnMut(u64),
{
    use std::io::{Read, Write};
    let mut reader = fs::File::open(src)?;
    let mut writer = fs::File::create(dst)?;
    let mut buf = vec![0u8; 512 * 1024]; // 512KB buffer for optimal NVMe/SSD throughput
    let mut written = 0u64;
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfer canceled",
            ));
        }
        while pause_flag.load(Ordering::Relaxed) {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Transfer canceled",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        written += n as u64;
        on_chunk(n as u64);
    }
    Ok(written)
}

/// Managed clipboard state: mirrors to and reads from the real Windows `CF_HDROP`
/// OS clipboard so Copy/Cut/Paste works seamlessly with Windows Explorer, Desktop, and apps.
#[derive(Default)]
pub struct Clipboard {
    pub paths: Vec<PathBuf>,
    pub cut: bool,
}

impl Clipboard {
    fn clear(&mut self) {
        self.paths.clear();
        self.cut = false;
    }
}

#[tauri::command]
pub fn set_clipboard(
    paths: Vec<String>,
    mode: String,
    clip: State<'_, Mutex<Clipboard>>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Nothing to store in clipboard".into());
    }
    let is_cut = mode == "cut";
    #[cfg(windows)]
    {
        let _ = write_os_file_clipboard(&paths, is_cut);
    }
    let mut clip = clip.lock().map_err(|_| "Clipboard poisoned")?;
    clip.paths = paths.into_iter().map(PathBuf::from).collect();
    clip.cut = is_cut;
    Ok(())
}

/// Check whether either Fast Explorer or the Windows OS clipboard holds file paths.
#[tauri::command]
pub fn has_clipboard(clip: State<'_, Mutex<Clipboard>>) -> bool {
    if let Ok(guard) = clip.lock() {
        if !guard.paths.is_empty() {
            return true;
        }
    }
    #[cfg(windows)]
    {
        return os_has_file_clipboard();
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Paste the clipboard contents into `dest_dir` with live progress reporting,
/// pause/resume/cancel controls, and pairs output for full undo/redo.
#[tauri::command]
pub async fn paste(
    app: AppHandle,
    dest_dir: String,
    clip: State<'_, Mutex<Clipboard>>,
    ctrl: State<'_, TransferControlState>,
) -> Result<PasteResult, String> {
    let (sources, is_cut, from_os) = {
        let mut clip = clip.lock().map_err(|_| "Clipboard poisoned")?;
        #[cfg(windows)]
        let (s, is_cut, fo) = if let Some((os_paths, os_cut)) = read_os_file_clipboard() {
            (os_paths, os_cut, true)
        } else {
            (clip.paths.clone(), clip.cut, false)
        };
        #[cfg(not(windows))]
        let (s, is_cut, fo) = (clip.paths.clone(), clip.cut, false);

        if is_cut {
            clip.clear();
        }
        (s, is_cut, fo)
    };

    if sources.is_empty() {
        return Err("Clipboard is empty".into());
    }

    let cancel_flag = Arc::clone(&ctrl.cancel_flag);
    let pause_flag = Arc::clone(&ctrl.pause_flag);
    cancel_flag.store(false, Ordering::Relaxed);
    pause_flag.store(false, Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        let (total_files, total_bytes) = compute_total_bytes(&sources);
        let bytes_copied = Arc::new(AtomicU64::new(0));
        let files_completed = Arc::new(AtomicUsize::new(0));
        let start_time = Instant::now();
        let mut last_emit = Instant::now();

        let source_dir = sources
            .first()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dest_str = dest.to_string_lossy().into_owned();
        let op_type = if is_cut { "move" } else { "copy" }.to_string();

        let bytes_ref = Arc::clone(&bytes_copied);
        let files_ref = Arc::clone(&files_completed);
        let pause_c = Arc::clone(&pause_flag);
        let emit_progress = move |app: &AppHandle, cur_file: &str, done: bool, canceled: bool, err: Option<String>| {
            let copied = bytes_ref.load(Ordering::Relaxed);
            let finished = files_ref.load(Ordering::Relaxed);
            let elapsed_secs = start_time.elapsed().as_secs_f32().max(0.001);
            let speed_mbps = (copied as f32 / (1024.0 * 1024.0)) / elapsed_secs;
            let percent = if total_bytes > 0 {
                (copied as f32 / total_bytes as f32) * 100.0
            } else if total_files > 0 {
                (finished as f32 / total_files as f32) * 100.0
            } else {
                100.0
            };
            let _ = app.emit(
                "transfer-progress",
                &TransferProgress {
                    op_type: op_type.clone(),
                    source_dir: source_dir.clone(),
                    dest_dir: dest_str.clone(),
                    current_file: cur_file.to_string(),
                    files_completed: finished,
                    total_files,
                    bytes_copied: copied,
                    total_bytes,
                    percent: percent.clamp(0.0, 100.0),
                    speed_mbps,
                    is_move: is_cut,
                    is_paused: pause_c.load(Ordering::Relaxed),
                    done,
                    canceled,
                    error: err,
                },
            );
            if let Some(win) = app.get_webview_window("transfer") {
                let _ = win.show();
            }
        };

        let mut errors: Vec<String> = Vec::new();
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut was_canceled = false;

        emit_progress(&app, "Preparing...", false, false, None);

        for src in &sources {
            if cancel_flag.load(Ordering::Relaxed) {
                was_canceled = true;
                break;
            }
            let fname = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
            emit_progress(&app, &fname, false, false, None);

            let (result, target_path) = if is_cut {
                let target = unique_dest_path(src, &dest);
                let res = fs::rename(src, &target)
                    .map_err(|e| e.to_string())
                    .or_else(|_| persistence_fallback_move(src, &dest));
                (res, target)
            } else if src.is_dir() {
                let res = copy_recursive(src, &dest, true);
                match res {
                    Ok(t) => (Ok(()), t),
                    Err(e) => (Err(e), dest.clone()),
                }
            } else {
                let target = unique_dest_path(src, &dest);
                let app_c = app.clone();
                let fname_c = fname.clone();
                let b_ref = Arc::clone(&bytes_copied);
                let res = copy_file_with_progress(src, &target, &cancel_flag, &pause_flag, |chunk| {
                    b_ref.fetch_add(chunk, Ordering::Relaxed);
                    if last_emit.elapsed().as_millis() >= 80 {
                        last_emit = Instant::now();
                        emit_progress(&app_c, &fname_c, false, false, None);
                    }
                })
                .map(|_| ())
                .map_err(|e| e.to_string());
                (res, target)
            };

            if cancel_flag.load(Ordering::Relaxed) {
                was_canceled = true;
                if !is_cut && target_path.exists() {
                    let _ = fs::remove_file(&target_path);
                }
                break;
            }

            if let Err(e) = result {
                errors.push(format!("{}: {}", fname, e));
            } else {
                files_completed.fetch_add(1, Ordering::Relaxed);
                pairs.push((
                    src.to_string_lossy().into_owned(),
                    target_path.to_string_lossy().into_owned(),
                ));
            }
        }

        if is_cut && !was_canceled {
            #[cfg(windows)]
            if from_os {
                clear_os_clipboard();
            }
        }

        if start_time.elapsed().as_millis() < 250 && !was_canceled {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        emit_progress(
            &app,
            "",
            true,
            was_canceled,
            if errors.is_empty() { None } else { Some(errors.join("\n")) },
        );

        if was_canceled {
            return Ok(PasteResult { is_cut, pairs });
        }
        if errors.is_empty() {
            Ok(PasteResult { is_cut, pairs })
        } else {
            Err(errors.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move items with live progress reporting (used for drag and drop moves).
#[tauri::command]
pub async fn move_items_with_progress(
    app: AppHandle,
    paths: Vec<String>,
    dest_dir: String,
    ctrl: State<'_, TransferControlState>,
) -> Result<PasteResult, String> {
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if sources.is_empty() {
        return Ok(PasteResult { is_cut: true, pairs: Vec::new() });
    }

    let cancel_flag = Arc::clone(&ctrl.cancel_flag);
    let pause_flag = Arc::clone(&ctrl.pause_flag);
    cancel_flag.store(false, Ordering::Relaxed);
    pause_flag.store(false, Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        let (total_files, total_bytes) = compute_total_bytes(&sources);
        let bytes_copied = Arc::new(AtomicU64::new(0));
        let files_completed = Arc::new(AtomicUsize::new(0));
        let start_time = Instant::now();

        let source_dir = sources
            .first()
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dest_str = dest.to_string_lossy().into_owned();

        let bytes_ref = Arc::clone(&bytes_copied);
        let files_ref = Arc::clone(&files_completed);
        let pause_c = Arc::clone(&pause_flag);
        let emit_progress = move |app: &AppHandle, cur_file: &str, done: bool, canceled: bool, err: Option<String>| {
            let copied = bytes_ref.load(Ordering::Relaxed);
            let finished = files_ref.load(Ordering::Relaxed);
            let elapsed_secs = start_time.elapsed().as_secs_f32().max(0.001);
            let speed_mbps = (copied as f32 / (1024.0 * 1024.0)) / elapsed_secs;
            let percent = if total_bytes > 0 {
                (copied as f32 / total_bytes as f32) * 100.0
            } else if total_files > 0 {
                (finished as f32 / total_files as f32) * 100.0
            } else {
                100.0
            };
            let _ = app.emit(
                "transfer-progress",
                &TransferProgress {
                    op_type: "move".to_string(),
                    source_dir: source_dir.clone(),
                    dest_dir: dest_str.clone(),
                    current_file: cur_file.to_string(),
                    files_completed: finished,
                    total_files,
                    bytes_copied: copied,
                    total_bytes,
                    percent: percent.clamp(0.0, 100.0),
                    speed_mbps,
                    is_move: true,
                    is_paused: pause_c.load(Ordering::Relaxed),
                    done,
                    canceled,
                    error: err,
                },
            );
            if let Some(win) = app.get_webview_window("transfer") {
                let _ = win.show();
            }
        };

        emit_progress(&app, "Preparing to move...", false, false, None);

        let mut errors: Vec<String> = Vec::new();
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut was_canceled = false;

        for src in &sources {
            if cancel_flag.load(Ordering::Relaxed) {
                was_canceled = true;
                break;
            }
            let fname = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
            emit_progress(&app, &fname, false, false, None);

            let target = unique_dest_path(src, &dest);
            let result = fs::rename(src, &target)
                .map_err(|e| e.to_string())
                .or_else(|_| persistence_fallback_move(src, &dest));

            if cancel_flag.load(Ordering::Relaxed) {
                was_canceled = true;
                break;
            }

            if let Err(e) = result {
                errors.push(format!("{}: {}", fname, e));
            } else {
                files_completed.fetch_add(1, Ordering::Relaxed);
                pairs.push((
                    src.to_string_lossy().into_owned(),
                    target.to_string_lossy().into_owned(),
                ));
            }
        }

        if start_time.elapsed().as_millis() < 250 && !was_canceled {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        emit_progress(
            &app,
            "",
            true,
            was_canceled,
            if errors.is_empty() { None } else { Some(errors.join("\n")) },
        );

        if was_canceled {
            return Ok(PasteResult { is_cut: true, pairs });
        }
        if errors.is_empty() {
            Ok(PasteResult { is_cut: true, pairs })
        } else {
            Err(errors.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// On Windows, `fs::rename` fails across volumes (e.g. C: -> D:); fall back to
/// copy + delete for cut operations.
fn persistence_fallback_move(src: &Path, dest: &Path) -> Result<(), String> {
    copy_recursive(src, dest, false)?;
    if src.is_dir() {
        fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Explorer-style destination naming: `"file - Copy.ext"` / `"file - Copy (2).ext"`
/// when pasting into the same folder or onto an existing name.
fn unique_dest_path(src: &Path, dest_dir: &Path) -> PathBuf {
    let Some(fname) = src.file_name() else {
        return dest_dir.to_path_buf();
    };
    let candidate = dest_dir.join(fname);
    if !candidate.exists() {
        return candidate;
    }
    let is_dir = src.is_dir();
    let stem = if is_dir {
        fname.to_string_lossy().into_owned()
    } else {
        src.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| fname.to_string_lossy().into_owned())
    };
    let ext = if is_dir {
        String::new()
    } else {
        src.extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default()
    };

    let first_copy = dest_dir.join(format!("{stem} - Copy{ext}"));
    if !first_copy.exists() {
        return first_copy;
    }
    let mut n = 2usize;
    loop {
        let p = dest_dir.join(format!("{stem} - Copy ({n}){ext}"));
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

/// Recursively copy `src` into `dst_dir`, returning the new destination path.
fn copy_recursive(src: &Path, dst_dir: &Path, auto_rename: bool) -> Result<PathBuf, String> {
    if !src.exists() {
        return Err("Source file no longer exists.".into());
    }
    let target = if auto_rename {
        unique_dest_path(src, dst_dir)
    } else {
        let t = dst_dir.join(src.file_name().ok_or("Source has no file name")?);
        if t.exists() {
            return Err(format!(
                "\"{}\" already exists in the destination.",
                t.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        t
    };
    if src.is_dir() {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for e in fs::read_dir(src).map_err(|e| e.to_string())? {
            let child = e.map_err(|e| e.to_string())?.path();
            copy_recursive(&child, &target, false)?;
        }
    } else {
        fs::copy(src, &target).map_err(|e| e.to_string())?;
    }
    Ok(target)
}

#[cfg(windows)]
fn os_has_file_clipboard() -> bool {
    use windows::Win32::System::DataExchange::IsClipboardFormatAvailable;
    use windows::Win32::System::Ole::CF_HDROP;
    unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() }
}

#[cfg(windows)]
fn clear_os_clipboard() {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard};
    unsafe {
        if OpenClipboard(None).is_ok() {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    }
}

#[cfg(windows)]
fn write_os_file_clipboard(paths: &[String], is_cut: bool) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    let mut wide_files: Vec<u16> = Vec::new();
    for p in paths {
        wide_files.extend(p.encode_utf16());
        wide_files.push(0);
    }
    wide_files.push(0); // double-null terminator

    let header_bytes = std::mem::size_of::<DROPFILES>();
    let total_bytes = header_bytes + wide_files.len() * 2;

    unsafe {
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let _ = EmptyClipboard();

        if let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes) {
            let ptr = GlobalLock(hmem);
            if !ptr.is_null() {
                let df = ptr as *mut DROPFILES;
                (*df).pFiles = header_bytes as u32;
                (*df).fWide = true.into();
                std::ptr::copy_nonoverlapping(
                    wide_files.as_ptr(),
                    (ptr as *mut u8).add(header_bytes) as *mut u16,
                    wide_files.len(),
                );
                let _ = GlobalUnlock(hmem);
                let _ = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hmem.0)));
            }
        }

        // Preferred DropEffect: 2 = DROPEFFECT_MOVE (Cut), 5 = DROPEFFECT_COPY | DROPEFFECT_LINK
        let fmt_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        let fmt = RegisterClipboardFormatW(PCWSTR(fmt_name.as_ptr()));
        if fmt != 0 {
            if let Ok(heff) = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, 4) {
                let p = GlobalLock(heff) as *mut u32;
                if !p.is_null() {
                    *p = if is_cut { 2 } else { 5 };
                    let _ = GlobalUnlock(heff);
                    let _ = SetClipboardData(fmt, Some(HANDLE(heff.0)));
                }
            }
        }

        let _ = CloseClipboard();
    }
    Ok(())
}

#[cfg(windows)]
fn read_os_file_clipboard() -> Option<(Vec<PathBuf>, bool)> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() {
            return None;
        }
        OpenClipboard(None).ok()?;
        let mut out_paths = Vec::new();
        if let Ok(hdata) = GetClipboardData(CF_HDROP.0 as u32) {
            let hdrop = HDROP(hdata.0);
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
            for idx in 0..count {
                let len = DragQueryFileW(hdrop, idx, None);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    let actual = DragQueryFileW(hdrop, idx, Some(&mut buf));
                    if actual > 0 {
                        out_paths.push(PathBuf::from(String::from_utf16_lossy(
                            &buf[..actual as usize],
                        )));
                    }
                }
            }
        }

        let mut is_cut = false;
        let fmt_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        let fmt = RegisterClipboardFormatW(PCWSTR(fmt_name.as_ptr()));
        if fmt != 0 && IsClipboardFormatAvailable(fmt).is_ok() {
            if let Ok(heff) = GetClipboardData(fmt) {
                let hglob = HGLOBAL(heff.0);
                let ptr = GlobalLock(hglob) as *const u32;
                if !ptr.is_null() {
                    let val = *ptr;
                    is_cut = (val & 2) != 0 && (val & 1) == 0;
                    let _ = GlobalUnlock(hglob);
                }
            }
        }

        let _ = CloseClipboard();
        if out_paths.is_empty() {
            None
        } else {
            Some((out_paths, is_cut))
        }
    }
}

#[tauri::command]
pub fn get_drag_icon_path() -> String {
    let temp_icon = std::env::temp_dir().join("fast_explorer_drag_icon.png");
    if !temp_icon.exists() {
        let default_icon_bytes = include_bytes!("../../icons/icon.png");
        let _ = std::fs::write(&temp_icon, default_icon_bytes);
    }
    temp_icon.to_string_lossy().into_owned()
}

#[cfg(windows)]
#[tauri::command]
pub async fn start_native_drag(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, IDataObject};
        use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, IDropSource};
        use windows::Win32::UI::Shell::Common::ITEMIDLIST;
        use windows::Win32::UI::Shell::{
            BHID_DataObject, ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists,
            SHDoDragDrop, IShellItemArray,
        };

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let real_paths: Vec<String> = paths
                .into_iter()
                .filter(|p| !p.starts_with("shell:") && std::path::Path::new(p).exists())
                .collect();

            if real_paths.is_empty() {
                return Ok(());
            }

            let mut pidls: Vec<*const ITEMIDLIST> = Vec::new();
            for p in &real_paths {
                let hp = HSTRING::from(p);
                let pidl = ILCreateFromPathW(PCWSTR(hp.as_ptr()));
                if !pidl.is_null() {
                    pidls.push(pidl as *const ITEMIDLIST);
                }
            }
            if pidls.is_empty() {
                return Ok(());
            }

            let array_res = SHCreateShellItemArrayFromIDLists(&pidls);
            for pidl in &pidls {
                ILFree(Some(*pidl as *const _));
            }
            let shell_items: IShellItemArray = array_res.map_err(|e| e.to_string())?;

            let data_obj: IDataObject = shell_items
                .BindToHandler(None, &BHID_DataObject)
                .map_err(|e| e.to_string())?;

            let allowed = DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK;
            let _ = SHDoDragDrop(
                None,
                &data_obj,
                Option::<&IDropSource>::None,
                allowed,
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
pub fn start_native_drag(_paths: Vec<String>) -> Result<(), String> {
    Ok(())
}
