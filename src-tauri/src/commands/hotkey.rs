use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static WIN_E_ENABLED: AtomicBool = AtomicBool::new(false);
static WIN_KEY_DOWN: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

#[cfg(windows)]
pub mod windows_impl {
    use super::*;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW,
        TranslateMessage, KBDLLHOOKSTRUCT, MSG,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const VK_LWIN: u16 = 0x5B;
    const VK_RWIN: u16 = 0x5C;

    pub unsafe extern "system" fn keyboard_proc(
        ncode: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if ncode >= 0 {
            let msg = wparam.0 as u32;
            let kbd = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let vk = kbd.vkCode as u16;

            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if vk == VK_LWIN || vk == VK_RWIN {
                if is_down {
                    WIN_KEY_DOWN.store(true, Ordering::SeqCst);
                } else if is_up {
                    WIN_KEY_DOWN.store(false, Ordering::SeqCst);
                }
            } else if vk == 0x45 /* 'E' */ && is_down {
                if WIN_KEY_DOWN.load(Ordering::SeqCst) && WIN_E_ENABLED.load(Ordering::SeqCst) {
                    if let Ok(guard) = APP_HANDLE.lock() {
                        if let Some(ref app) = *guard {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("win-e-pressed", ());
                        }
                    }
                    // Suppress Win+E so Windows Explorer does not open!
                    return LRESULT(1);
                }
            }
        }

        CallNextHookEx(None, ncode, wparam, lparam)
    }

    pub fn start_hook(app: tauri::AppHandle) {
        if let Ok(mut guard) = APP_HANDLE.lock() {
            *guard = Some(app);
        }

        std::thread::spawn(|| unsafe {
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_proc),
                None,
                0,
            );

            if hook.is_err() {
                return;
            }

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }
}

pub fn init_hotkey_listener(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        // Check if user previously enabled Win+E interception
        let config_file = dirs::config_dir()
            .map(|d| d.join("xplorer").join("win_e_enabled"))
            .unwrap_or_default();
        if config_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_file) {
                if content.trim() == "1" || content.trim() == "true" {
                    WIN_E_ENABLED.store(true, Ordering::SeqCst);
                }
            }
        }
        windows_impl::start_hook(app);
    }
}

#[tauri::command]
pub fn is_win_e_interception_enabled() -> Result<bool, String> {
    Ok(WIN_E_ENABLED.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn set_win_e_interception_enabled(enabled: bool) -> Result<(), String> {
    WIN_E_ENABLED.store(enabled, Ordering::SeqCst);
    if let Some(dir) = dirs::config_dir().map(|d| d.join("xplorer")) {
        let _ = std::fs::create_dir_all(&dir);
        let config_file = dir.join("win_e_enabled");
        let _ = std::fs::write(&config_file, if enabled { "1" } else { "0" });
    }
    Ok(())
}
