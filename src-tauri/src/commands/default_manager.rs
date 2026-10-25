#[cfg(windows)]
pub mod windows_impl {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const DIR_CMD_PATH: &str = r"Software\Classes\Directory\shell\open\command";
    const DIR_SHELL_OPEN: &str = r"Software\Classes\Directory\shell\open";
    const DRIVE_CMD_PATH: &str = r"Software\Classes\Drive\shell\open\command";
    const DRIVE_SHELL_OPEN: &str = r"Software\Classes\Drive\shell\open";

    pub fn is_default() -> Result<bool, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_lowercase();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(dir_cmd) = hkcu.open_subkey(DIR_CMD_PATH) {
            if let Ok(val) = dir_cmd.get_value::<String, _>("") {
                if val.to_lowercase().contains(&exe_str) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub fn set_as_default() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();
        let command_val = format!("\"{}\" \"%1\"", exe_str);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // Directory\shell\open\command
        let (dir_cmd, _) = hkcu
            .create_subkey(DIR_CMD_PATH)
            .map_err(|e| format!("Failed to create Directory shell key: {}", e))?;
        dir_cmd
            .set_value("", &command_val)
            .map_err(|e| format!("Failed to set Directory command: {}", e))?;

        // Drive\shell\open\command
        let (drive_cmd, _) = hkcu
            .create_subkey(DRIVE_CMD_PATH)
            .map_err(|e| format!("Failed to create Drive shell key: {}", e))?;
        drive_cmd
            .set_value("", &command_val)
            .map_err(|e| format!("Failed to set Drive command: {}", e))?;

        Ok(())
    }

    pub fn unset_as_default() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(DIR_SHELL_OPEN);
        let _ = hkcu.delete_subkey_all(DRIVE_SHELL_OPEN);
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
