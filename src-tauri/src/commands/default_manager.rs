use std::sync::atomic::{AtomicBool, Ordering};

static BACKGROUND_RESIDENT: AtomicBool = AtomicBool::new(true);

pub fn init_background_state() {
    let config_file = dirs::config_dir()
        .map(|d| d.join("xplorer").join("background_resident"))
        .unwrap_or_default();
    if config_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_file) {
            let trimmed = content.trim();
            if trimmed == "0" || trimmed == "false" {
                BACKGROUND_RESIDENT.store(false, Ordering::SeqCst);
            } else {
                BACKGROUND_RESIDENT.store(true, Ordering::SeqCst);
            }
        }
    }
}

pub fn should_keep_in_background() -> bool {
    BACKGROUND_RESIDENT.load(Ordering::SeqCst)
}

#[cfg(windows)]
pub mod windows_impl {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const DIR_SHELL_PATH: &str = r"Software\Classes\Directory\shell";
    const DIR_CMD_PATH: &str = r"Software\Classes\Directory\shell\open\command";
    const DIR_SHELL_OPEN: &str = r"Software\Classes\Directory\shell\open";
    const DRIVE_SHELL_PATH: &str = r"Software\Classes\Drive\shell";
    const DRIVE_CMD_PATH: &str = r"Software\Classes\Drive\shell\open\command";
    const DRIVE_SHELL_OPEN: &str = r"Software\Classes\Drive\shell\open";
    const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE_NAME: &str = "Xplorer";

    /// Resolve the best executable path to register (prefers installed release binary if present).
    pub fn preferred_exe_path() -> Result<String, String> {
        if let Some(local_data) = dirs::data_local_dir() {
            let installed = local_data.join("Programs").join("Xplorer").join("xplorer.exe");
            if installed.exists() {
                return Ok(installed.to_string_lossy().to_string());
            }
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(exe.to_string_lossy().to_string())
    }

    pub fn is_default() -> Result<bool, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(dir_cmd) = hkcu.open_subkey(DIR_CMD_PATH) {
            if let Ok(val) = dir_cmd.get_value::<String, _>("") {
                if val.to_lowercase().contains("xplorer.exe") {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub fn set_as_default() -> Result<(), String> {
        let exe_str = preferred_exe_path()?;
        let command_val = format!("\"{}\" \"%1\"", exe_str);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // Directory\shell -> default verb "open"
        if let Ok((dir_shell, _)) = hkcu.create_subkey(DIR_SHELL_PATH) {
            let _ = dir_shell.set_value("", &"open");
        }

        // Directory\shell\open\command
        let (dir_cmd, _) = hkcu
            .create_subkey(DIR_CMD_PATH)
            .map_err(|e| format!("Failed to create Directory shell key: {}", e))?;
        dir_cmd
            .set_value("", &command_val)
            .map_err(|e| format!("Failed to set Directory command: {}", e))?;
        let _ = dir_cmd.delete_value("DelegateExecute");

        // Drive\shell -> default verb "open"
        if let Ok((drive_shell, _)) = hkcu.create_subkey(DRIVE_SHELL_PATH) {
            let _ = drive_shell.set_value("", &"open");
        }

        // Drive\shell\open\command
        let (drive_cmd, _) = hkcu
            .create_subkey(DRIVE_CMD_PATH)
            .map_err(|e| format!("Failed to create Drive shell key: {}", e))?;
        drive_cmd
            .set_value("", &command_val)
            .map_err(|e| format!("Failed to set Drive command: {}", e))?;
        let _ = drive_cmd.delete_value("DelegateExecute");

        Ok(())
    }

    pub fn unset_as_default() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(DIR_SHELL_OPEN);
        let _ = hkcu.delete_subkey_all(DRIVE_SHELL_OPEN);
        if let Ok((dir_shell, _)) = hkcu.create_subkey(DIR_SHELL_PATH) {
            let _ = dir_shell.set_value("", &"none");
        }
        if let Ok((drive_shell, _)) = hkcu.create_subkey(DRIVE_SHELL_PATH) {
            let _ = drive_shell.set_value("", &"none");
        }
        Ok(())
    }

    pub fn is_autostart() -> Result<bool, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(run_key) = hkcu.open_subkey(RUN_KEY_PATH) {
            if let Ok(val) = run_key.get_value::<String, _>(RUN_VALUE_NAME) {
                if val.to_lowercase().contains("xplorer.exe") {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub fn set_autostart(enabled: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run_key, _) = hkcu
            .create_subkey(RUN_KEY_PATH)
            .map_err(|e| format!("Failed to open Run key: {}", e))?;

        if enabled {
            let exe_str = preferred_exe_path()?;
            let cmd = format!("\"{}\" --background", exe_str);
            run_key
                .set_value(RUN_VALUE_NAME, &cmd)
                .map_err(|e| format!("Failed to set autostart value: {}", e))?;
        } else {
            let _ = run_key.delete_value(RUN_VALUE_NAME);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn is_default_file_manager() -> Result<bool, String> {
    #[cfg(windows)]
    {
        windows_impl::is_default()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn set_as_default_file_manager() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::set_as_default()
    }
    #[cfg(not(windows))]
    {
        Err("Default file manager registration is only supported on Windows".into())
    }
}

#[tauri::command]
pub fn unset_as_default_file_manager() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::unset_as_default()
    }
    #[cfg(not(windows))]
    {
        Err("Default file manager unregistration is only supported on Windows".into())
    }
}

#[tauri::command]
pub fn is_autostart_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        windows_impl::is_autostart()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::set_autostart(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Autostart is only supported on Windows".into())
    }
}

#[tauri::command]
pub fn is_background_resident_enabled() -> Result<bool, String> {
    Ok(BACKGROUND_RESIDENT.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn set_background_resident_enabled(enabled: bool) -> Result<(), String> {
    BACKGROUND_RESIDENT.store(enabled, Ordering::SeqCst);
    if let Some(dir) = dirs::config_dir().map(|d| d.join("xplorer")) {
        let _ = std::fs::create_dir_all(&dir);
        let config_file = dir.join("background_resident");
        let _ = std::fs::write(&config_file, if enabled { "1" } else { "0" });
    }
    Ok(())
}
