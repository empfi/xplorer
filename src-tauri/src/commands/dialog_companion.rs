use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetDlgItem, GetForegroundWindow, IsWindow,
    IsWindowVisible, PostMessageW, SendMessageW, WM_KEYDOWN, WM_KEYUP, WM_SETTEXT,
};

static COMPANION_ENABLED: AtomicBool = AtomicBool::new(true);
static AUTO_JUMP_ENABLED: AtomicBool = AtomicBool::new(true);
static ACTIVE_FOLDER: Mutex<String> = Mutex::new(String::new());
static RECENT_TABS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LAST_HANDLED_DIALOG: Mutex<Option<usize>> = Mutex::new(None);

/// Synchronize the active Xplorer tab folder and open tabs list from the frontend.
#[tauri::command]
pub fn sync_active_folder(active_path: String, tabs: Vec<String>) -> Result<(), String> {
    if !active_path.starts_with("shell:") && !active_path.starts_with("upnp::") {
        if let Ok(mut guard) = ACTIVE_FOLDER.lock() {
            *guard = active_path;
        }
    }
    if let Ok(mut guard) = RECENT_TABS.lock() {
        *guard = tabs
            .into_iter()
            .filter(|p| !p.starts_with("shell:") && !p.starts_with("upnp::"))
            .collect();
    }
    Ok(())
}

/// Check if a window is a standard Windows file dialog (#32770).
pub unsafe fn is_file_dialog(hwnd: HWND) -> bool {
    if !IsWindow(Some(hwnd)).as_bool() {
        return false;
    }
    let mut class_buf = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut class_buf);
    if len <= 0 {
        return false;
    }
    let cls = String::from_utf16_lossy(&class_buf[..len as usize]);
    if cls != "#32770" {
        return false;
    }

    // Verify it contains file dialog controls (SHELLDLL_DefView, DirectUIHWND, or edit box)
    let mut has_shell_view = false;
    let _ = EnumChildWindows(
        Some(hwnd),
        Some(enum_check_file_dialog),
        LPARAM(&mut has_shell_view as *mut bool as isize),
    );
    has_shell_view
}

unsafe extern "system" fn enum_check_file_dialog(child: HWND, lparam: LPARAM) -> BOOL {
    let mut class_buf = [0u16; 64];
    let len = GetClassNameW(child, &mut class_buf);
    if len > 0 {
        let cls = String::from_utf16_lossy(&class_buf[..len as usize]);
        if cls == "SHELLDLL_DefView" || cls == "DirectUIHWND" {
            let found = &mut *(lparam.0 as *mut bool);
            *found = true;
            return BOOL(0); // Found, stop enumeration
        }
    }
    BOOL(1) // Continue
}

/// Find the file name Edit control inside a file dialog.
pub unsafe fn find_file_name_edit(h_dlg: HWND) -> Option<HWND> {
    // 1. Standard control ID for the filename edit box is 0x047C (1148).
    if let Ok(item) = GetDlgItem(Some(h_dlg), 0x047C) {
        if !item.0.is_null() && IsWindowVisible(item).as_bool() {
            return Some(item);
        }
    }

    // 2. In ComboBoxEx32 (ID 0x047E = 1150), find child Edit.
    if let Ok(combo) = GetDlgItem(Some(h_dlg), 0x047E) {
        if !combo.0.is_null() {
            let mut edit_out = HWND::default();
            let _ = EnumChildWindows(
                Some(combo),
                Some(enum_find_edit),
                LPARAM(&mut edit_out as *mut HWND as isize),
            );
            if !edit_out.0.is_null() {
                return Some(edit_out);
            }
        }
    }

    // 3. Fallback: Search all children for visible Edit controls.
    let mut edits: Vec<HWND> = Vec::new();
    let _ = EnumChildWindows(
        Some(h_dlg),
        Some(enum_collect_edits),
        LPARAM(&mut edits as *mut Vec<HWND> as isize),
    );

    // Pick the last edit control (typically the filename box at the bottom, not the search/address at top)
    edits.pop()
}

unsafe extern "system" fn enum_find_edit(child: HWND, lparam: LPARAM) -> BOOL {
    let mut class_buf = [0u16; 64];
    let len = GetClassNameW(child, &mut class_buf);
    if len > 0 {
        let cls = String::from_utf16_lossy(&class_buf[..len as usize]);
        if cls.eq_ignore_ascii_case("Edit") && IsWindowVisible(child).as_bool() {
            let out = &mut *(lparam.0 as *mut HWND);
            *out = child;
            return BOOL(0);
        }
    }
    BOOL(1)
}

unsafe extern "system" fn enum_collect_edits(child: HWND, lparam: LPARAM) -> BOOL {
    let mut class_buf = [0u16; 64];
    let len = GetClassNameW(child, &mut class_buf);
    if len > 0 {
        let cls = String::from_utf16_lossy(&class_buf[..len as usize]);
        if cls.eq_ignore_ascii_case("Edit") && IsWindowVisible(child).as_bool() {
            let edits = &mut *(lparam.0 as *mut Vec<HWND>);
            edits.push(child);
        }
    }
    BOOL(1)
}

/// Navigate an Open/Save file dialog window to the specified directory.
pub unsafe fn navigate_dialog_to_dir(h_dlg: HWND, dir_path: &str) -> bool {
    let edit = match find_file_name_edit(h_dlg) {
        Some(e) => e,
        None => return false,
    };

    let trimmed = dir_path.trim_end_matches('\\').to_string() + "\\";
    let wide_path: Vec<u16> = std::ffi::OsStr::new(&trimmed)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // 1. Set the directory path in the filename Edit control
    let _ = SendMessageW(
        edit,
        WM_SETTEXT,
        Some(WPARAM(0)),
        Some(LPARAM(wide_path.as_ptr() as isize)),
    );

    std::thread::sleep(std::time::Duration::from_millis(40));

    // 2. Send Enter key down & up to trigger Windows Explorer dialog navigation
    // When a directory path ending with \ is submitted, the dialog navigates to it without closing.
    let _ = PostMessageW(Some(edit), WM_KEYDOWN, WPARAM(0x0D /* VK_RETURN */), LPARAM(0x001C0001));
    let _ = PostMessageW(Some(edit), WM_KEYUP, WPARAM(0x0D /* VK_RETURN */), LPARAM(0xC01C0001));

    true
}

/// Quick-switch: triggers navigation of the currently focused file dialog
/// to Xplorer's active folder.
#[tauri::command]
pub fn quick_switch_file_dialog() -> Result<bool, String> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return Ok(false);
        }

        if is_file_dialog(fg) {
            let path = ACTIVE_FOLDER.lock().unwrap().clone();
            if !path.is_empty() && std::path::Path::new(&path).is_dir() {
                return Ok(navigate_dialog_to_dir(fg, &path));
            }
        }
    }
    Ok(false)
}

/// Spawns the background monitor that listens for file dialogs appearing.
pub fn start_dialog_companion_watcher(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(350));

            if !COMPANION_ENABLED.load(Ordering::Relaxed) {
                continue;
            }

            unsafe {
                let fg = GetForegroundWindow();
                if fg.0.is_null() {
                    continue;
                }

                if is_file_dialog(fg) {
                    let hwnd_val = fg.0 as usize;
                    let is_new = {
                        let mut last = LAST_HANDLED_DIALOG.lock().unwrap();
                        if *last != Some(hwnd_val) {
                            *last = Some(hwnd_val);
                            true
                        } else {
                            false
                        }
                    };

                    if is_new {
                        let active = ACTIVE_FOLDER.lock().unwrap().clone();
                        let tabs = RECENT_TABS.lock().unwrap().clone();

                        // Emit event to frontend with file dialog presence
                        let _ = app_handle.emit(
                            "file-dialog-detected",
                            serde_json::json!({
                                "hwnd": hwnd_val,
                                "active_folder": active,
                                "tabs": tabs,
                            }),
                        );

                        // If auto-jump is enabled and we have a valid folder, navigate immediately!
                        if AUTO_JUMP_ENABLED.load(Ordering::Relaxed) {
                            if !active.is_empty() && std::path::Path::new(&active).is_dir() {
                                // Small delay to let the dialog finish initial initialization
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                navigate_dialog_to_dir(fg, &active);
                            }
                        }
                    }
                } else {
                    let mut last = LAST_HANDLED_DIALOG.lock().unwrap();
                    if last.is_some() {
                        *last = None;
                        let _ = app_handle.emit("file-dialog-closed", ());
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub fn is_dialog_companion_enabled() -> Result<bool, String> {
    Ok(COMPANION_ENABLED.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn set_dialog_companion_enabled(enabled: bool) -> Result<(), String> {
    COMPANION_ENABLED.store(enabled, Ordering::Relaxed);
    if let Some(dir) = dirs::config_dir().map(|d| d.join("xplorer")) {
        let _ = std::fs::create_dir_all(&dir);
        let config_file = dir.join("companion_enabled");
        let _ = std::fs::write(&config_file, if enabled { "1" } else { "0" });
    }
    Ok(())
}

#[tauri::command]
pub fn is_auto_jump_enabled() -> Result<bool, String> {
    Ok(AUTO_JUMP_ENABLED.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn set_auto_jump_enabled(enabled: bool) -> Result<(), String> {
    AUTO_JUMP_ENABLED.store(enabled, Ordering::Relaxed);
    if let Some(dir) = dirs::config_dir().map(|d| d.join("xplorer")) {
        let _ = std::fs::create_dir_all(&dir);
        let config_file = dir.join("auto_jump_enabled");
        let _ = std::fs::write(&config_file, if enabled { "1" } else { "0" });
    }
    Ok(())
}

#[tauri::command]
pub fn jump_dialog_to_path(target_path: String) -> Result<bool, String> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return Ok(false);
        }
        if is_file_dialog(fg) {
            return Ok(navigate_dialog_to_dir(fg, &target_path));
        }
    }
    Ok(false)
}
