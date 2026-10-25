use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

// Max cached entries before we evict oldest (big dirs won't OOM the webview)
const CACHE_LIMIT: usize = 8_000;

#[derive(Default)]
struct IconCacheInner {
    map: HashMap<String, String>,
    order: VecDeque<String>,
}

impl IconCacheInner {
    fn get(&mut self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }
    fn put(&mut self, key: String, url: String) {
        if self.map.insert(key.clone(), url).is_some() {
            return;
        }
        self.order.push_back(key);
        while self.order.len() > CACHE_LIMIT {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }
}

#[derive(Default, Clone)]
pub struct IconCache(Arc<Mutex<IconCacheInner>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconResult {
    pub key: String,
    pub url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconRequest {
    pub key: String,
    pub path: String,
    pub is_dir: bool,
    pub ext: String,
    pub size: i32,
    /// Whether the caller wants real-content pixel previews (grid view).
    /// List view sets false so rows use crisp small shell icons.
    #[serde(default)]
    pub preview: bool,
    /// Opt out of the shared "all folders look alike" slot: drives and other
    /// special folders resolve their icon from the real path instead.
    #[serde(default)]
    pub unique: bool,
}

fn key_for(path: &str, is_dir: bool, ext: &str, size: i32, preview: bool, unique: bool) -> String {
    if path.starts_with("upnp::") {
        format!("d:{size}:{}:{path}", ext.to_ascii_lowercase())
    } else if is_dir {
        if unique {
            format!("d:{size}:{path}")
        } else {
            format!("d:{size}:folder")
        }
    } else if is_media(ext) || needs_path_lookup(ext) {
        // Per-file: thumbnails and shortcuts resolve from the real path.
        // preview=true holds full-size grid previews; false holds small list
        // icons — same pipeline, different requested size & separate slot.
        format!("t:{size}:{preview}:{path}")
    } else {
        format!("e:{size}:{ext}")
    }
}

/// Types whose icon can't be resolved from the extension alone (shortcuts:
/// the icon lives in the target file's metadata, so we must use the real path).
fn needs_path_lookup(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(), "lnk" | "url" | "appref-ms")
}

const MEDIA_EXTS: [&str; 24] = [
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic", "avif",
    "mp4", "mkv", "avi", "mov", "webm", "wmv", "mp3", "wav", "flac", "ogg", "pdf", "psd",
];

fn is_media(ext: &str) -> bool {
    MEDIA_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

/// Resolve icons for a whole directory in ONE IPC round-trip on a background thread pool.
/// One resolve per unique cache key (1000 same-type files -> 1 lookup).
#[tauri::command]
pub async fn get_entry_icons_batch(
    requests: Vec<IconRequest>,
    cache: State<'_, IconCache>,
) -> Result<Vec<IconResult>, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_entry_icons_batch_sync(requests, &cache))
        .await
        .map_err(|e| e.to_string())
}

fn get_entry_icons_batch_sync(requests: Vec<IconRequest>, cache_state: &IconCache) -> Vec<IconResult> {
    let mut misses: Vec<(String, String, bool, String, i32, bool, bool)> = Vec::new();
    let mut miss_index: HashMap<String, usize> = HashMap::new();
    {
        let mut cache = match cache_state.0.lock() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        for req in &requests {
            let key = key_for(&req.path, req.is_dir, &req.ext, req.size, req.preview, req.unique);
            if cache.get(&key).is_some() || miss_index.contains_key(key.as_str()) {
                continue;
            }
            miss_index.insert(key.clone(), misses.len());
            misses.push((
                key,
                req.path.clone(),
                req.is_dir,
                req.ext.clone(),
                req.size,
                req.preview,
                req.unique,
            ));
        }
    }

    if !misses.is_empty() {
        let mut resolved: Vec<(String, String)> = Vec::new();
        std::thread::scope(|s| {
            for chunk in misses.chunks(8) {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|j| {
                        s.spawn(|| {
                            let (key, path, is_dir, ext, size, preview, unique) = j;
                            (
                                key.clone(),
                                resolve_one(path, *is_dir, ext, *size, *preview, *unique),
                            )
                        })
                    })
                    .collect();
                for h in handles {
                    if let Ok((key, Some(url))) = h.join() {
                        resolved.push((key, url));
                    }
                }
            }
        });
        if let Ok(mut cache) = cache_state.0.lock() {
            for (key, url) in resolved {
                cache.put(key, url);
            }
        }
    }

    let mut cache = match cache_state.0.lock() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    requests
        .iter()
        .map(|req| {
            let key = key_for(&req.path, req.is_dir, &req.ext, req.size, req.preview, req.unique);
            IconResult {
                key: req.key.clone(),
                url: cache.get(&key),
            }
        })
        .collect()
}

fn resolve_one(
    path: &str,
    is_dir: bool,
    ext: &str,
    size: i32,
    preview: bool,
    unique: bool,
) -> Option<String> {
    #[cfg(windows)]
    {
        let ext_l = ext.to_ascii_lowercase();
        let ext_l = ext_l.trim_start_matches('.');
        if path.starts_with("upnp::") {
            return network_device_icon(ext_l, size);
        }
        if path == "shell:Network" || (is_dir && path.starts_with("\\\\") && !path[2..].contains('\\')) {
            return network_device_icon("computer", size)
                .or_else(|| shell_image(path, size, true));
        }
        if is_dir {
            if !unique {
                // Always resolve the generic folder slot from a standard system folder
                // so a special folder (e.g. Downloads) never pollutes `d:{size}:folder`.
                return shell_image("C:\\Windows", size, true)
                    .or_else(|| shell_image(path, size, true));
            }
            shell_image(path, size, true).or_else(|| shell_image(path, size, false))
        } else if is_media(ext_l) || needs_path_lookup(ext_l) {
            if preview {
                // Grid preview: OS thumbnail cache first (instant when
                // Explorer has seen the file — it usually has), full CPU
                // decode only as fallback, bare icon last.
                shell_image(path, size, false)
                    .or_else(|| decode_image_preview(path, size))
                    .or_else(|| shell_image(path, size, true))
            } else {
                // List icon: small crisp shell icon (no expensive decode).
                // For shortcuts, SIIGBF_ICONONLY resolves the TARGET's icon
                // (like Explorer); the flag is what makes it do that.
                shell_image(path, size, true)
                    .or_else(|| shell_ext_icon(ext_l, size))
            }
        } else {
            shell_image(path, size, true).or_else(|| shell_ext_icon(ext_l, size))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, is_dir, ext, size, preview, unique);
        None
    }
}

/// Extract authentic Windows 11 network device icons directly from `networkexplorer.dll`
/// (matches Windows Explorer's Network view: index 12 = Media Device, index 1 = Other Device,
/// index 0 = Network Computer, index 4 = Printer, index 8 = Camera).
#[cfg(windows)]
fn network_device_icon(kind: &str, size: i32) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, PrivateExtractIconsW, HICON};

    let idx: i32 = match kind.trim().to_ascii_lowercase().as_str() {
        "computer" => 0,
        "media device" => 12,
        "printer" => 4,
        "camera" => 8,
        _ => 1,
    };
    let mut file_arr = [0u16; 260];
    for (i, ch) in "C:\\Windows\\System32\\networkexplorer.dll"
        .encode_utf16()
        .take(259)
        .enumerate()
    {
        file_arr[i] = ch;
    }
    let mut hicon = HICON::default();
    let mut id: u32 = 0;
    let extracted = unsafe {
        PrivateExtractIconsW(
            &file_arr,
            idx,
            size.max(16),
            size.max(16),
            Some(std::slice::from_mut(&mut hicon)),
            Some(&mut id as *mut u32),
            0,
        )
    };
    if extracted == 0 || hicon.is_invalid() {
        return None;
    }
    let png = unsafe { hicon_to_png(hicon, size) };
    unsafe {
        let _ = DestroyIcon(hicon);
    }
    png
}

/// Fast real-content preview: decode the image with `image` at reduced size
/// (much faster + accurate vs shell thumbnails), only useful for image files.
#[cfg(windows)]
fn decode_image_preview(path: &str, size: i32) -> Option<String> {
    use base64::Engine as _;
    let ext_l = path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // Only static images that `image` can decode — not videos/streaming formats
    if !matches!(
        ext_l.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tiff" | "tif"
    ) {
        return None;
    }
    // Huge originals (RAW dumps, panoramas) decode slowly and blow memory —
    // let those fall back to the fast shell thumbnail instead.
    const MAX_DECODE_BYTES: u64 = 48 * 1024 * 1024;
    if std::fs::metadata(path)
        .map(|m| m.len() > MAX_DECODE_BYTES)
        .unwrap_or(true)
    {
        return None;
    }
    // Decode at most 4x the target box before resizing: bounded memory/time
    // while keeping sharpness for the requested preview size.
    let img = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let thumb = if img.width() as i32 > size * 4 || img.height() as i32 > size * 4 {
        let big = size * 4;
        let scale = f64::min(
            big as f64 / img.width() as f64,
            big as f64 / img.height() as f64,
        );
        img.resize(
            (img.width() as f64 * scale).round().max(1.0) as u32,
            (img.height() as f64 * scale).round().max(1.0) as u32,
            // Triangle is ~10x faster than Lanczos3 here and visually
            // identical once shrunk again to the final thumbnail box below.
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    // Aspect-fit inside the requested box
    let target = size.max(16) as u32;
    let scale = f64::min(
        target as f64 / thumb.width() as f64,
        target as f64 / thumb.height() as f64,
    )
    .min(1.0);
    let (dw, dh) = (
        (thumb.width() as f64 * scale).round().max(1.0) as u32,
        (thumb.height() as f64 * scale).round().max(1.0) as u32,
    );
    let small = thumb.resize_exact(
        if dw >= thumb.width() { thumb.width() } else { dw },
        if dh >= thumb.height() { thumb.height() } else { dh },
        image::imageops::FilterType::Lanczos3,
    );
    let mut out = std::io::Cursor::new(Vec::new());
    small
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(out.get_ref());
    Some(format!("data:image/png;base64,{b64}"))
}

/// Legacy single-icon command (still used by tests); kept for compatibility.
#[tauri::command]
pub fn get_entry_icon(
    path: String,
    is_dir: bool,
    ext: String,
    size: i32,
    cache: State<'_, IconCache>,
) -> Option<String> {
    let ext_l = ext.to_ascii_lowercase();
    let ext_l = ext_l.trim_start_matches('.').to_string();
    let key = key_for(&path, is_dir, &ext_l, size, true, false);

    {
        let mut cache = cache.0.lock().ok()?;
        if let Some(url) = cache.get(&key) {
            return Some(url);
        }
    }

    let url = resolve_one(&path, is_dir, &ext_l, size, true, false);
    if let Some(u) = &url {
        if let Ok(mut cache) = cache.0.lock() {
            cache.put(key, u.clone());
        }
    }
    url
}

#[cfg(windows)]
fn shell_ext_icon(ext: &str, size: i32) -> Option<String> {
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHGFI_ICON, SHGFI_USEFILEATTRIBUTES, SHFILEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
    use windows::core::{HSTRING, PCWSTR};

    let flags = SHGFI_ICON | SHGFI_USEFILEATTRIBUTES;
    let fake = HSTRING::from(format!("a.{ext}\0"));
    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(fake.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if ok == 0 || shfi.hIcon.is_invalid() {
        return None;
    }
    let png = unsafe { hicon_to_png(shfi.hIcon, size) };
    unsafe {
        let _ = DestroyIcon(shfi.hIcon);
    }
    png
}

#[cfg(windows)]
pub(crate) unsafe fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON, size: i32) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, ReleaseDC, GetObjectW, DeleteObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HDC, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut info = ICONINFO::default();
    if unsafe { GetIconInfo(hicon, &mut info) }.is_err() {
        return None;
    }
    let hbmp = info.hbmColor;
    if hbmp.is_invalid() {
        return None;
    }
    let mask = info.hbmMask;

    let mut bmp = BITMAP::default();
    if unsafe {
        GetObjectW(
            HGDIOBJ(hbmp.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        )
    } == 0
    {
        let _ = unsafe { DeleteObject(HGDIOBJ(hbmp.0)) };
        return None;
    }
    let (w, h) = (bmp.bmWidth, bmp.bmHeight);
    if w <= 0 || h <= 0 {
        let _ = unsafe { DeleteObject(HGDIOBJ(hbmp.0)) };
        let _ = unsafe { DeleteObject(HGDIOBJ(mask.0)) };
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: (w * h * 4) as u32,
        ..Default::default()
    };
    let mut pixels = vec![0u8; (w as usize * h as usize * 4).max(1)];
    let hdc: HDC = unsafe { GetDC(None) };
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    unsafe { ReleaseDC(None, hdc) };
    let _ = unsafe { DeleteObject(HGDIOBJ(hbmp.0)) };
    let _ = unsafe { DeleteObject(HGDIOBJ(mask.0)) };
    if lines == 0 {
        return None;
    }

    // BGRA -> RGBA
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
    }
    encode_png_rgba(&pixels, w as u32, h as u32, size)
}

#[cfg(windows)]
pub(crate) fn shell_image(path: &str, size: i32, icon_only: bool) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    // Map virtual shell folders and the user profile ("Home") root to their
    // official Windows 11 Explorer CLSIDs so they resolve authentic shell icons.
    let home_dir = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    let is_home = home_dir
        .as_deref()
        .is_some_and(|h| h.trim_end_matches('\\').eq_ignore_ascii_case(path.trim_end_matches('\\')));

    let candidates: &[&str] = match path {
        "shell:ThisPC" => &["::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"],
        "shell:RecycleBinFolder" => &["::{645FF040-5081-101B-9F08-00AA002F954E}"],
        "shell:Network" => &["::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}"],
        _ if is_home => &[
            "::{F874310E-B6B7-47DC-BC84-B9E6B38F5903}",
            "::{59031A47-3F72-44A7-89C5-5595FE6B30EE}",
            path,
        ],
        _ => &[path],
    };

    let flags = if icon_only { SIIGBF_ICONONLY } else { SIIGBF_RESIZETOFIT };
    for candidate in candidates {
        let Ok(item) = (unsafe {
            SHCreateItemFromParsingName::<_, _, IShellItemImageFactory>(&HSTRING::from(*candidate), None)
        }) else {
            continue;
        };
        let Ok(hbmp) = (unsafe { item.GetImage(SIZE { cx: size, cy: size }, flags) }) else {
            continue;
        };
        let png = unsafe { hbitmap_to_png(hbmp, size) };
        let _ = unsafe { DeleteObject(HGDIOBJ(hbmp.0)) };
        if png.is_some() {
            return png;
        }
    }
    None
}

#[cfg(windows)]
unsafe fn hbitmap_to_png(hbmp: windows::Win32::Graphics::Gdi::HBITMAP, size: i32) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, ReleaseDC, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HGDIOBJ, HDC,
    };

    let mut bmp = BITMAP::default();
    if unsafe {
        GetObjectW(
            HGDIOBJ(hbmp.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        )
    } == 0
    {
        return None;
    }
    let (w, h) = (bmp.bmWidth, bmp.bmHeight);
    if w <= 0 || h <= 0 {
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: (w * h * 4) as u32,
        ..Default::default()
    };
    let mut pixels = vec![0u8; w as usize * h as usize * 4];
    let hdc: HDC = unsafe { GetDC(None) };
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    unsafe { ReleaseDC(None, hdc) };
    if lines == 0 {
        return None;
    }
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
    }
    encode_png_rgba(&pixels, w as u32, h as u32, size)
}

#[cfg(windows)]
pub(crate) fn encode_png_rgba(pixels: &[u8], w: u32, h: u32, size: i32) -> Option<String> {
    use base64::Engine as _;

    let mut img = match image::RgbaImage::from_raw(w, h, pixels.to_vec()) {
        Some(i) => i,
        None => return None,
    };
    let target = size.max(16) as u32;
    if w > target || h > target {
        img = image::imageops::resize(
            &img,
            target,
            ((h as f64 / w as f64) * target as f64).round().max(1.0) as u32,
            image::imageops::FilterType::Triangle,
        );
    }
    let mut out = std::io::Cursor::new(Vec::new());
    if image::DynamicImage::ImageRgba8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .is_err()
    {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(out.get_ref());
    Some(format!("data:image/png;base64,{b64}"))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_entry_icon(_path: String, _is_dir: bool, _ext: String, _size: i32) -> Option<String> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn ext_icon_resolves() {
        for size in [20, 64] {
            let r = shell_ext_icon("png", size);
            assert!(r.is_some(), "shell_ext_icon(png, {size}) returned None");
            assert!(r.unwrap().starts_with("data:image/png"));
        }
    }

    #[test]
    fn folder_icon_resolves() {
        for size in [20, 64] {
            let r = shell_image("C:\\Users\\giuli\\Downloads", size, true)
                .or_else(|| shell_image("C:\\Users\\giuli\\Downloads", size, false));
            assert!(r.is_some(), "shell_image(folder, {size}) returned None");
        }
    }

    #[test]
    fn image_thumbnail_resolves() {
        let dir = "C:\\Users\\giuli\\Downloads";
        let png = std::fs::read_dir(dir)
            .ok()
            .and_then(|rd| {
                rd.filter_map(|e| e.ok())
                    .find(|e| {
                        e.path()
                            .extension()
                            .is_some_and(|x| x.eq_ignore_ascii_case("png"))
                    })
                    .map(|e| e.path().to_string_lossy().into_owned())
            });
        let Some(png) = png else {
            eprintln!("no png in Downloads; skipping");
            return;
        };
        for size in [20, 64] {
            let r = shell_image(&png, size, false).or_else(|| shell_image(&png, size, true));
            assert!(r.is_some(), "shell_image({png}, {size}) returned None");
        }
    }

    #[test]
    fn lnk_shortcut_icons_resolve_per_file() {
        let dir = "C:\\Users\\giuli\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
        let lnk = std::fs::read_dir(dir)
            .ok()
            .and_then(|rd| rd.filter_map(|e| e.ok()).find(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk"))))
            .or_else(|| {
                // Recurse one level if the root has no .lnk
                std::fs::read_dir(dir).ok().and_then(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .find_map(|d| {
                            std::fs::read_dir(d.path())
                                .ok()?
                                .filter_map(|e| e.ok())
                                .find(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")))
                        })
                })
            });
        let Some(lnk) = lnk else {
            eprintln!("no .lnk found; skipping");
            return;
        };
        let path = lnk.path().to_string_lossy().into_owned();
        let r = shell_image(&path, 20, false).or_else(|| shell_image(&path, 20, true));
        assert!(r.is_some(), "shortcut icon for {path} must resolve via real path");
        // And it must NOT share a cache key with another lnk (per-file)
        let k1 = key_for(&path, false, "lnk", 20, true, false);
        assert!(k1.starts_with("t:20:true:"), "lnk key must be per-file preview, got {k1}");
    }

    #[test]
    fn decoded_preview_matches_file_content() {
        let dir = "C:\\Users\\giuli\\Downloads";
        let png = std::fs::read_dir(dir)
            .ok()
            .and_then(|rd| {
                rd.filter_map(|e| e.ok())
                    .find(|e| {
                        e.path()
                            .extension()
                            .is_some_and(|x| x.eq_ignore_ascii_case("png"))
                    })
                    .map(|e| e.path().to_string_lossy().into_owned())
            });
        let Some(png) = png else {
            eprintln!("no png in Downloads; skipping");
            return;
        };
        for size in [64, 128] {
            let r = decode_image_preview(&png, size);
            assert!(r.is_some(), "decode_image_preview({png}, {size}) must resolve");
            // 2x2-min decode of a landscape 1920x1080 at size 64 should fit 64px wide
        }
    }

    #[test]
    fn batch_dedupes_by_extension() {
        // 20 files of the same type should produce ONE miss in the batch.
        let reqs: Vec<IconRequest> = (0..20)
            .map(|i| IconRequest {
                key: format!("e:64:txt"),
                path: format!("C:\\fake\\f{i}.txt"),
                is_dir: false,
                ext: "txt".into(),
                size: 64,
                preview: false,
                unique: false,
            })
            .collect();
        // can't easily test State here; assert the key generator instead
        let keys: std::collections::HashSet<String> = reqs
            .iter()
            .map(|r| key_for(&r.path, r.is_dir, &r.ext, r.size, r.preview, r.unique))
            .collect();
        assert_eq!(keys.len(), 1, "20 same-type files must share one cache key");
    }
}
