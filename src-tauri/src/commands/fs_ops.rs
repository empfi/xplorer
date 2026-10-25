use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub size: String,
    pub item_type: String,
    pub modified: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FsEntry>,
    /// Non-fatal error, e.g. "Access denied" on partially readable folders.
    pub error: Option<String>,
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{} bytes", bytes)
    }
}

fn is_hidden(meta: &fs::Metadata, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

pub fn item_type(name: &str, is_dir: bool) -> String {
    if is_dir {
        return "File folder".into();
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    #[cfg(windows)]
    if let Some(ref ext_l) = ext {
        if let Some(shell_type) = cached_shell_type_name(ext_l) {
            return shell_type;
        }
    }

    match ext.as_deref() {
        Some("txt") => "Text Document".into(),
        Some("exe") | Some("msi") | Some("bat") | Some("cmd") => "Application".into(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("bmp") | Some("webp")
        | Some("svg") | Some("ico") => {
            format!("{} File", ext.unwrap().to_ascii_uppercase())
        }
        Some("mp4") | Some("mkv") | Some("avi") | Some("mov") => "Video".into(),
        Some("mp3") | Some("wav") | Some("flac") => "Audio".into(),
        Some("zip") | Some("7z") | Some("rar") => "Compressed folder".into(),
        Some("pdf") => "PDF Document".into(),
        Some("rs") => "Rust Source".into(),
        Some("ts") => "TypeScript Source".into(),
        Some("js") => "JavaScript Source".into(),
        Some(e) => format!("{} File", e.to_ascii_uppercase()),
        None => "File".into(),
    }
}

/// Zero-I/O Windows Shell file type lookup (`"WinRAR ZIP archive"`, `"MP4 Video"`,
/// `"Firefox PDF Document"`), memoized per extension so directory scans stay instant.
#[cfg(windows)]
fn cached_shell_type_name(ext_lower: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES,
    };

    static TYPE_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let map_lock = TYPE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = map_lock.lock() {
        if let Some(cached) = guard.get(ext_lower) {
            return cached.clone();
        }
    }

    let fake = HSTRING::from(format!("a.{ext_lower}"));
    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(fake.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES,
        )
    };
    let resolved = if ok != 0 {
        let len = shfi
            .szTypeName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(shfi.szTypeName.len());
        let s = String::from_utf16_lossy(&shfi.szTypeName[..len])
            .trim()
            .to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    };

    if let Ok(mut guard) = map_lock.lock() {
        guard.insert(ext_lower.to_string(), resolved.clone());
    }
    resolved
}

fn to_entry(e: fs::DirEntry) -> Option<FsEntry> {
    let name = e.file_name().to_string_lossy().into_owned();
    if name == "$RECYCLE.BIN" || name == "System Volume Information" || name == "desktop.ini" {
        return None;
    }
    let meta = e.metadata().ok()?;
    let is_dir = meta.is_dir();
    let modified: DateTime<Local> = meta.modified().ok()?.into();
    Some(FsEntry {
        path: e.path().to_string_lossy().into_owned(),
        is_dir,
        is_hidden: is_hidden(&meta, &name),
        size: if is_dir { String::new() } else { human_size(meta.len()) },
        item_type: item_type(&name, is_dir),
        modified: modified.format("%d/%m/%Y %H:%M").to_string(),
        name,
    })
}

/// List a directory. Per-entry errors are skipped; a top-level read error is
/// reported as `error` (e.g. access-denied) while remaining entries still show.
#[tauri::command]
pub fn list_dir(path: String) -> Result<DirListing, String> {
    if path.eq_ignore_ascii_case("shell:RecycleBinFolder") {
        let listing = crate::commands::recycle::list_recycle_bin()?;
        return Ok(DirListing {
            path: path.clone(),
            entries: listing.entries,
            error: None,
        });
    }
    // A bare drive letter ("C:") is drive-relative on Windows (resolves to the
    // process working directory); always treat it as the drive root.
    let path = if path.len() == 2 && path.ends_with(':') {
        format!("{path}\\")
    } else {
        path
    };
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    match fs::read_dir(&dir) {
        Ok(rd) => {
            let mut entries: Vec<FsEntry> = Vec::new();
            for e in rd {
                match e {
                    Ok(entry) => {
                        if let Some(fse) = to_entry(entry) {
                            entries.push(fse);
                        }
                    }
                    Err(_) => continue,
                }
            }
            entries.sort_unstable_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(DirListing {
                path: dir.to_string_lossy().into_owned(),
                entries,
                error: None,
            })
        }
        Err(e) => {
            let msg = match e.kind() {
                std::io::ErrorKind::PermissionDenied => "Access denied.".to_string(),
                _ => e.to_string(),
            };
            Ok(DirListing { path: path.clone(), entries: Vec::new(), error: Some(msg) })
        }
    }
}

#[tauri::command]
pub fn rename_item(from: String, to: String) -> Result<(), String> {
    let from = PathBuf::from(&from);
    let parent = from
        .parent()
        .ok_or("Cannot determine parent folder")?
        .to_path_buf();
    fs::rename(&from, parent.join(&to)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("\"{}\" already exists.", to)
        } else {
            e.to_string()
        }
    })
}

#[tauri::command]
pub async fn delete_items(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let show_progress = total > 0;
        let parent_dir = paths
            .first()
            .and_then(|p| std::path::Path::new(p).parent())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        if show_progress {
            use tauri::{Emitter, Manager};
            if let Some(win) = app.get_webview_window("transfer") {
                let _ = win.show();
            }
            let _ = app.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "delete",
                    "source_dir": parent_dir,
                    "dest_dir": "Recycle Bin",
                    "current_file": "Preparing to delete...",
                    "files_completed": 0,
                    "total_files": total,
                    "bytes_copied": 0,
                    "total_bytes": 0,
                    "percent": 0.0,
                    "speed_mbps": 0.0,
                    "is_move": false,
                    "is_paused": false,
                    "done": false,
                    "canceled": false,
                    "error": null,
                }),
            );
        }

        let start_time = std::time::Instant::now();

        for (idx, p) in paths.iter().enumerate() {
            let fname = std::path::Path::new(p)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();

            if show_progress {
                use tauri::Emitter;
                let _ = app.emit(
                    "transfer-progress",
                    &serde_json::json!({
                        "op_type": "delete",
                        "source_dir": parent_dir,
                        "dest_dir": "Recycle Bin",
                        "current_file": fname,
                        "files_completed": idx,
                        "total_files": total,
                        "bytes_copied": 0,
                        "total_bytes": 0,
                        "percent": (idx as f32 / total as f32) * 100.0,
                        "speed_mbps": 0.0,
                        "is_move": false,
                        "is_paused": false,
                        "done": false,
                        "canceled": false,
                        "error": null,
                    }),
                );
            }

            trash::delete(p).map_err(|e| e.to_string())?;
        }

        if show_progress {
            if start_time.elapsed().as_millis() < 250 {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            use tauri::Emitter;
            let _ = app.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "delete",
                    "source_dir": parent_dir,
                    "dest_dir": "Recycle Bin",
                    "current_file": "",
                    "files_completed": total,
                    "total_files": total,
                    "bytes_copied": 0,
                    "total_bytes": 0,
                    "percent": 100.0,
                    "speed_mbps": 0.0,
                    "is_move": false,
                    "is_paused": false,
                    "done": true,
                    "canceled": false,
                    "error": null,
                }),
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Permanently delete files/folders (Shift+Delete or Recycle Bin delete).
#[tauri::command]
pub async fn delete_items_permanently(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let show_progress = total > 0;
        let parent_dir = paths
            .first()
            .and_then(|p| std::path::Path::new(p).parent())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        if show_progress {
            use tauri::{Emitter, Manager};
            if let Some(win) = app.get_webview_window("transfer") {
                let _ = win.show();
            }
            let _ = app.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "delete",
                    "source_dir": parent_dir,
                    "dest_dir": "Permanent Delete",
                    "current_file": "Preparing to delete...",
                    "files_completed": 0,
                    "total_files": total,
                    "bytes_copied": 0,
                    "total_bytes": 0,
                    "percent": 0.0,
                    "speed_mbps": 0.0,
                    "is_move": false,
                    "is_paused": false,
                    "done": false,
                    "canceled": false,
                    "error": null,
                }),
            );
        }

        let start_time = std::time::Instant::now();

        for (idx, p) in paths.iter().enumerate() {
            let path = Path::new(p);
            if !path.exists() {
                continue;
            }
            let fname = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();

            if show_progress {
                use tauri::Emitter;
                let _ = app.emit(
                    "transfer-progress",
                    &serde_json::json!({
                        "op_type": "delete",
                        "source_dir": parent_dir,
                        "dest_dir": "Permanent Delete",
                        "current_file": fname,
                        "files_completed": idx,
                        "total_files": total,
                        "bytes_copied": 0,
                        "total_bytes": 0,
                        "percent": (idx as f32 / total as f32) * 100.0,
                        "speed_mbps": 0.0,
                        "is_move": false,
                        "is_paused": false,
                        "done": false,
                        "canceled": false,
                        "error": null,
                    }),
                );
            }

            if path.is_dir() {
                fs::remove_dir_all(path).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }

        if show_progress {
            if start_time.elapsed().as_millis() < 250 {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            use tauri::Emitter;
            let _ = app.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "delete",
                    "source_dir": parent_dir,
                    "dest_dir": "Permanent Delete",
                    "current_file": "",
                    "files_completed": total,
                    "total_files": total,
                    "bytes_copied": 0,
                    "total_bytes": 0,
                    "percent": 100.0,
                    "speed_mbps": 0.0,
                    "is_move": false,
                    "is_paused": false,
                    "done": true,
                    "canceled": false,
                    "error": null,
                }),
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a file or folder (used for copy redo).
#[tauri::command]
pub fn copy_item(from: String, to: String) -> Result<(), String> {
    let from_p = Path::new(&from);
    let to_p = Path::new(&to);
    if !from_p.exists() {
        return Err(format!("Source does not exist: {}", from));
    }
    if from_p.is_dir() {
        copy_dir_all(from_p, to_p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = to_p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(from_p, to_p).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Move a file or folder (cross-drive safe: falls back to copy-then-delete).
#[tauri::command]
pub fn move_item(from: String, to: String) -> Result<(), String> {
    let from_p = Path::new(&from);
    let to_p = Path::new(&to);
    if !from_p.exists() {
        return Err(format!("source not found: {}", from));
    }
    if to_p.exists() {
        return Err(format!("target already exists: {}", to));
    }
    fs::rename(from_p, to_p).or_else(|e| {
        // Cross-drive rename fails; copy the tree/file then delete the source.
        if from_p.is_dir() {
            copy_dir_all(from_p, to_p).map_err(|_| e.to_string())?;
            fs::remove_dir_all(from_p).map_err(|er| er.to_string())?;
        } else {
            fs::copy(from_p, to_p).map_err(|_| e.to_string())?;
            fs::remove_file(from_p).map_err(|er| er.to_string())?;
        }
        Ok(())
    })
}

/// Recursive directory copy used by the cross-drive move fallback.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Create an empty folder, returning the new path.
#[tauri::command]
pub fn create_folder(parent_dir: String, name: String) -> Result<String, String> {
    let target = Path::new(&parent_dir).join(&name);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Create an empty file (e.g. New → Text Document), returning the new path.
/// Creates it even if a file with that literal name already exists with a
/// different case; fine for the action bar's controlled usage.
#[tauri::command]
pub fn create_empty_file(parent_dir: String, name: String) -> Result<String, String> {
    let mut target = Path::new(&parent_dir).join(&name);
    // Suffix " (n)" before the extension until unused, like Explorer
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let mut n = 0;
    while target.exists() {
        n += 1;
        target = Path::new(&parent_dir).join(format!("{stem} ({n}){ext}"));
    }
    fs::write(&target, b"").map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FileMetadata {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub size_formatted: String,
    pub created: String,
    pub modified: String,
    pub accessed: String,
    pub item_type: String,
    pub is_dir: bool,
    pub is_readonly: bool,
    pub is_hidden: bool,
}

/// Retrieve detailed filesystem and shell metadata for the Details pane.
#[tauri::command]
pub fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_dir = meta.is_dir();
    let is_ro = meta.permissions().readonly();
    let hidden = is_hidden(&meta, &name);

    let fmt_time = |t: std::io::Result<std::time::SystemTime>| -> String {
        t.ok()
            .map(|st| {
                let dt: DateTime<Local> = st.into();
                dt.format("%d/%m/%Y %H:%M:%S").to_string()
            })
            .unwrap_or_else(|| "-".into())
    };

    Ok(FileMetadata {
        path: path.clone(),
        name: name.clone(),
        extension: ext,
        size_bytes: meta.len(),
        size_formatted: if is_dir {
            String::new()
        } else {
            human_size(meta.len())
        },
        created: fmt_time(meta.created()),
        modified: fmt_time(meta.modified()),
        accessed: fmt_time(meta.accessed()),
        item_type: item_type(&name, is_dir),
        is_dir,
        is_readonly: is_ro,
        is_hidden: hidden,
    })
}

/// Read text preview for text, code, markdown, and config files up to `max_bytes` (default 128KB).
#[tauri::command]
pub fn read_text_preview(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    use std::io::Read;
    let limit = max_bytes.unwrap_or(128 * 1024);
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; limit];
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(bytes_read);
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Read an image or media file and return a base64 data: URL for high-performance preview in WebView2.
#[tauri::command]
pub fn read_file_as_data_url(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Read;

    let limit = max_bytes.unwrap_or(25 * 1024 * 1024);
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    while buffer.len() < limit {
        let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }

    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buffer);
    Ok(format!("data:{mime};base64,{b64}"))
}

use std::collections::VecDeque;

fn score_match(name_lower: &str, query: &str) -> Option<u32> {
    if name_lower == query {
        Some(100)
    } else if name_lower.starts_with(query) {
        Some(85)
    } else if let Some(pos) = name_lower.find(query) {
        if pos > 0 {
            let prev_char = name_lower.as_bytes()[pos - 1];
            if matches!(prev_char, b'_' | b'-' | b'.' | b' ' | b'/' | b'\\') {
                return Some(75);
            }
        }
        Some(50)
    } else {
        None
    }
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("$RECYCLE.BIN")
        || name.eq_ignore_ascii_case("System Volume Information")
        || name.eq_ignore_ascii_case("node_modules")
        || name.eq_ignore_ascii_case(".git")
        || name.eq_ignore_ascii_case(".svn")
        || name.eq_ignore_ascii_case(".hg")
        || name.eq_ignore_ascii_case("target")
        || name.eq_ignore_ascii_case(".vs")
        || name.eq_ignore_ascii_case(".idea")
}

/// Search files and folders using a breadth-first algorithm prioritizing current folder first,
/// then shallow subfolders, then deep subfolders.
#[tauri::command]
pub async fn search_files(
    dir_path: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&dir_path);
        if !root.is_dir() {
            return Err("Invalid directory".into());
        }
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }

        let words: Vec<&str> = q.split_whitespace().collect();
        let limit = max_results.unwrap_or(500);

        let match_entry = |name_lower: &str| -> Option<u32> {
            if words.len() <= 1 {
                score_match(name_lower, &q)
            } else {
                let all_matched = words.iter().all(|w| name_lower.contains(w));
                if all_matched {
                    Some(60)
                } else {
                    None
                }
            }
        };

        let root_str = root.to_string_lossy();
        let skip_heavy = !root_str.contains("node_modules")
            && !root_str.contains(".git")
            && !root_str.contains("target");

        let mut current_matches: Vec<(u32, FsEntry)> = Vec::new();
        let mut subfolder_queue: VecDeque<(PathBuf, usize)> = VecDeque::new();

        // 1. First pass: Search CURRENT folder directly (depth 0)
        if let Ok(rd) = fs::read_dir(root) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "$RECYCLE.BIN" || name == "System Volume Information" {
                    continue;
                }
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                let path = entry.path();
                let name_lower = name.to_lowercase();

                if let Some(score) = match_entry(&name_lower) {
                    if let Some(fe) = to_entry(entry) {
                        current_matches.push((score, fe));
                    }
                }

                if is_dir {
                    if !skip_heavy || !should_skip_dir(&name) {
                        subfolder_queue.push_back((path, 1));
                    }
                }
            }
        }

        current_matches.sort_unstable_by(|(s_a, e_a), (s_b, e_b)| {
            s_b.cmp(s_a)
                .then_with(|| e_b.is_dir.cmp(&e_a.is_dir))
                .then_with(|| e_a.name.to_lowercase().cmp(&e_b.name.to_lowercase()))
        });

        // 2. Second pass: Breadth-first search across subfolders level-by-level
        let mut subfolder_matches: Vec<(usize, u32, FsEntry)> = Vec::new();
        const MAX_DEPTH: usize = 12;
        let start_time = std::time::Instant::now();
        let mut dirs_scanned = 0;
        const MAX_DIRS: usize = 3500;
        const MAX_TIME_MS: u128 = 2000;

        while let Some((dir, depth)) = subfolder_queue.pop_front() {
            if current_matches.len() + subfolder_matches.len() >= limit {
                break;
            }
            if depth > MAX_DEPTH {
                continue;
            }
            dirs_scanned += 1;
            if dirs_scanned > MAX_DIRS || start_time.elapsed().as_millis() > MAX_TIME_MS {
                break;
            }

            let rd = match fs::read_dir(&dir) {
                Ok(rd) => rd,
                Err(_) => continue,
            };

            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "$RECYCLE.BIN" || name == "System Volume Information" {
                    continue;
                }
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                let path = entry.path();
                let name_lower = name.to_lowercase();

                if let Some(score) = match_entry(&name_lower) {
                    if let Some(fe) = to_entry(entry) {
                        let final_score = score.saturating_sub((depth as u32) * 3);
                        subfolder_matches.push((depth, final_score, fe));
                        if current_matches.len() + subfolder_matches.len() >= limit {
                            break;
                        }
                    }
                }

                if is_dir && depth < MAX_DEPTH {
                    if !skip_heavy || !should_skip_dir(&name) {
                        subfolder_queue.push_back((path, depth + 1));
                    }
                }
            }
        }

        subfolder_matches.sort_unstable_by(|(d_a, s_a, e_a), (d_b, s_b, e_b)| {
            d_a.cmp(d_b)
                .then_with(|| s_b.cmp(s_a))
                .then_with(|| e_b.is_dir.cmp(&e_a.is_dir))
                .then_with(|| e_a.name.to_lowercase().cmp(&e_b.name.to_lowercase()))
        });

        // 3. Assemble: current folder matches FIRST, then subfolder matches
        let mut results = Vec::with_capacity(current_matches.len() + subfolder_matches.len());
        for (_, entry) in current_matches {
            results.push(entry);
        }
        for (_, _, entry) in subfolder_matches {
            results.push(entry);
        }

        if results.len() > limit {
            results.truncate(limit);
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_file_as_data_url() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_preview_sample.png");
        let sample_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4";
        fs::write(&test_file, sample_bytes).unwrap();
        let res = read_file_as_data_url(test_file.to_string_lossy().to_string(), None).unwrap();
        assert!(res.starts_with("data:image/png;base64,"));
        let _ = fs::remove_file(test_file);
    }

    #[test]
    fn test_search_files_current_folder_first_and_bfs() {
        let unique = format!("test_search_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let root = std::env::temp_dir().join(unique);
        let sub1 = root.join("sub1");
        let sub2 = sub1.join("sub2");
        fs::create_dir_all(&sub2).unwrap();

        let f_root = root.join("my_needle_root.txt");
        let f_shallow = sub1.join("my_needle_shallow.txt");
        let f_deep = sub2.join("my_needle_deep.txt");

        fs::write(&f_root, b"root").unwrap();
        fs::write(&f_shallow, b"shallow").unwrap();
        fs::write(&f_deep, b"deep").unwrap();

        let results = tauri::async_runtime::block_on(search_files(
            root.to_string_lossy().to_string(),
            "my_needle".to_string(),
            None,
        )).unwrap();

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].name, "my_needle_root.txt");
        assert_eq!(results[1].name, "my_needle_shallow.txt");
        assert_eq!(results[2].name, "my_needle_deep.txt");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_search_real_downloads() {
        let res = tauri::async_runtime::block_on(search_files(
            "C:\\Users\\giuli\\Downloads".to_string(),
            "jersey".to_string(),
            None,
        )).unwrap();
        println!("Downloads search results count: {}", res.len());
        for r in &res {
            println!("Found: {} ({})", r.name, r.path);
        }
    }
}

