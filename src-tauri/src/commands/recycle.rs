use serde::Serialize;

use super::fs_ops::{item_type, FsEntry};

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RecycleListing {
    pub entries: Vec<FsEntry>,
}

/// Enumerate the Recycle Bin through the Windows shell namespace.
/// `shell:RecycleBinFolder` is not a plain filesystem path, so plain
/// read_dir can't list it — this walks IShellItems instead and maps
/// each item into our normal FsEntry shape.
#[cfg(windows)]
#[tauri::command]
pub fn list_recycle_bin() -> Result<RecycleListing, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, CoTaskMemFree};
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, FOLDERID_RecycleBinFolder, IEnumShellItems, IShellItem,
        SHGetKnownFolderItem, SIGDN_NORMALDISPLAY, SIGDN_FILESYSPATH,
    };

    unsafe {
        // S_OK / S_FALSE (RPC_E_CHANGED_MODE) both fine.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    // Folder item for the Recycle Bin virtual location.
    let folder: IShellItem = unsafe {
        SHGetKnownFolderItem(
            &FOLDERID_RecycleBinFolder,
            windows::Win32::UI::Shell::KNOWN_FOLDER_FLAG(0),
            None,
        )
    }
    .map_err(|e| format!("Recycle Bin unavailable: {e}"))?;

    let enumerator: IEnumShellItems = unsafe { folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) }
        .map_err(|e| format!("Recycle Bin unavailable: {e}"))?;

    let mut entries: Vec<FsEntry> = Vec::new();
    let mut chunk: Vec<Option<IShellItem>> = vec![None; 64];
    unsafe {
        loop {
            let fetched_ptr: *mut u32 = &mut 0;
            enumerator
                .Next(&mut chunk, Some(fetched_ptr))
                .map_err(|e| e.to_string())?;
            let fetched = *(fetched_ptr as *const u32) as usize;
            if fetched == 0 {
                break;
            }
            for slot in chunk.iter().take(fetched) {
                let item = match slot {
                    Some(i) => i,
                    None => continue,
                };

                // Display name (what Explorer shows in the Bin)
                let name = item
                    .GetDisplayName(SIGDN_NORMALDISPLAY)
                    .ok()
                    .and_then(|p| {
                        let s = p.to_string().ok();
                        CoTaskMemFree(Some(p.as_ptr() as *const _));
                        s
                    })
                    .unwrap_or_else(|| "Unknown".to_string());

                // Original (pre-delete) path for previewing / type detection
                let path = item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .ok()
                    .and_then(|p| {
                        let s = p.to_string().ok();
                        CoTaskMemFree(Some(p.as_ptr() as *const _));
                        s
                    })
                    .unwrap_or_default();

                let is_dir = path.is_empty()
                    || std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                let size = if is_dir {
                    String::new()
                } else {
                    // Property storage for size; fall back to blank if hidden
                    String::new()
                };

                entries.push(FsEntry {
                    name: name.clone(),
                    path: if path.is_empty() { format!("shell:::{}", name) } else { path }, // placeholder path for non-filesystem items
                    is_dir,
                    is_hidden: false,
                    size,
                    item_type: item_type(&name, is_dir),
                    modified: String::new(),
                });
            }
        }
    }

    Ok(RecycleListing { entries })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_recycle_bin() -> Result<RecycleListing, String> {
    Ok(RecycleListing { entries: Vec::new() })
}

/// Restore items from the Recycle Bin back to their original locations
/// using the Windows Shell COM engine (the exact same engine Windows Explorer uses).
#[cfg(windows)]
pub async fn restore_items_internal(
    app: Option<&tauri::AppHandle>,
    paths: Vec<String>,
) -> Result<(), String> {
    let app_clone = app.cloned();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use tauri::{Emitter, Manager};

        if paths.is_empty() {
            return Ok(());
        }

        let total = paths.len();
        let start_time = std::time::Instant::now();

        if let Some(ref a) = app_clone {
            if let Some(win) = a.get_webview_window("transfer") {
                let _ = win.show();
            }
            let _ = a.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "restore",
                    "source_dir": "Recycle Bin",
                    "dest_dir": "Original Location",
                    "current_file": "Preparing to restore...",
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

        let json_paths = serde_json::to_string(&paths).map_err(|e| e.to_string())?;
        let script = format!(
            r#"
$paths = ConvertFrom-Json @'
{json_paths}
'@
$sh = New-Object -ComObject Shell.Application
$bin = $sh.Namespace(0xa)
$restored = 0
foreach ($item in $bin.Items()) {{
    $origLoc = $bin.GetDetailsOf($item, 1)
    $origFull = if ($origLoc) {{ Join-Path $origLoc $item.Name }} else {{ "" }}
    $binPath = $item.Path
    $name = $item.Name

    $match = $false
    foreach ($t in $paths) {{
        $normT = $t.TrimEnd('\', '/')
        if ($normT -eq $origFull.TrimEnd('\', '/') -or 
            $normT -eq $binPath.TrimEnd('\', '/') -or 
            $t -eq $name -or 
            $t -eq "shell:::$name") {{
            $match = $true
            break
        }}
    }}

    if ($match) {{
        foreach ($v in $item.Verbs()) {{
            if ($v.Name -match 'estore|undelete') {{
                $v.DoIt()
                $restored++
                [Console]::WriteLine("RESTORED:$name")
                break
            }}
        }}
    }}
}}
if ($restored -eq 0) {{
    exit 1
}}
exit 0
"#
        );

        const NO_WINDOW: u32 = 0x08000000;
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to run restore command: {e}"))?;

        let mut completed = 0;
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(restored_name) = line.strip_prefix("RESTORED:") {
                    completed += 1;
                    if let Some(ref a) = app_clone {
                        let percent = (completed as f32 / total as f32) * 100.0;
                        let _ = a.emit(
                            "transfer-progress",
                            &serde_json::json!({
                                "op_type": "restore",
                                "source_dir": "Recycle Bin",
                                "dest_dir": "Original Location",
                                "current_file": restored_name,
                                "files_completed": completed,
                                "total_files": total,
                                "bytes_copied": 0,
                                "total_bytes": 0,
                                "percent": percent,
                                "speed_mbps": 0.0,
                                "is_move": false,
                                "is_paused": false,
                                "done": false,
                                "canceled": false,
                                "error": null,
                            }),
                        );
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;

        if let Some(ref a) = app_clone {
            if start_time.elapsed().as_millis() < 300 {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            let _ = a.emit(
                "transfer-progress",
                &serde_json::json!({
                    "op_type": "restore",
                    "source_dir": "Recycle Bin",
                    "dest_dir": "Original Location",
                    "current_file": "",
                    "files_completed": if completed > 0 { total } else { 0 },
                    "total_files": total,
                    "bytes_copied": 0,
                    "total_bytes": 0,
                    "percent": if completed > 0 { 100.0 } else { 0.0 },
                    "speed_mbps": 0.0,
                    "is_move": false,
                    "is_paused": false,
                    "done": true,
                    "canceled": false,
                    "error": if !status.success() && completed == 0 {
                        Some("Could not restore selected item(s) from Recycle Bin.".to_string())
                    } else {
                        None
                    },
                }),
            );
        }

        if !status.success() && completed == 0 {
            return Err("Could not restore selected item(s) from Recycle Bin.".into());
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
#[tauri::command]
pub async fn restore_items(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    restore_items_internal(Some(&app), paths).await
}

#[cfg(not(windows))]
pub async fn restore_items_internal(
    _app: Option<&tauri::AppHandle>,
    _paths: Vec<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn restore_items(_app: tauri::AppHandle, _paths: Vec<String>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recycle_restore_flow() {
        tauri::async_runtime::block_on(async {
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("fast_explorer_unit_restore_test.txt");
            let _ = std::fs::write(&test_file, b"restore test payload");
            let path_str = test_file.to_string_lossy().to_string();

            let _ = trash::delete(&path_str);
            assert!(!test_file.exists(), "file should be in recycle bin");

            let res = restore_items_internal(None, vec![path_str.clone()]).await;
            assert!(res.is_ok(), "restore_items should succeed: {:?}", res);
            assert!(test_file.exists(), "file should be restored to original location");
            let _ = std::fs::remove_file(&test_file);
        });
    }
}
