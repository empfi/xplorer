use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellNewItem {
    /// Display label, e.g. "Text Document" or "WinRAR archive".
    pub label: String,
    /// File extension without dot, empty for the Folder entry.
    pub ext: String,
    /// How the item is materialized when picked.
    pub kind: ShellNewKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum ShellNewKind {
    /// Create a fresh empty file (no FileName/Data/Command in the registry).
    Empty,
    /// Copy an existing template file (registry value `FileName`).
    Template,
    /// Run a command line (registry value `Command`, e.g. WinRAR's .rar).
    Command,
}
// Note: the rare `Data` variant (bytes embedded in the registry) is treated
// as Empty; writing those exact bytes adds no practical value here.

#[cfg(windows)]
fn hcr() -> winreg::RegKey {
    winreg::RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT)
}

/// Friendly display name for an extension, resolved like Explorer: the
/// ProgID's localized/mutable name, else the ProgID key name prettified.
#[cfg(windows)]
fn friendly_name(ext: &str, prog_id: &str) -> String {
    let predef = hcr();
    let pid = predef.open_subkey(prog_id);
    if let Ok(pid) = pid {
        for value in ["FileTypeName", "Localized"] {
            if let Ok(s) = pid.get_value::<String, _>(value) {
                if !s.trim().is_empty() {
                    if let Some(n) = resolve_indirect(&s) {
                        return n;
                    }
                    return s;
                }
            }
        }
        if let Ok(s) = pid.get_value::<String, _>("") {
            if !s.trim().is_empty() {
                if let Some(n) = resolve_indirect(&s) {
                    return n;
                }
                return prettify_prog_id(&s).unwrap_or(s);
            }
        }
    }
    prettify_prog_id(prog_id)
        .unwrap_or_else(|| format!("{} file", ext.to_ascii_uppercase()))
}

/// "winrar.zip" -> "Winrar Zip"; also strips a trailing version suffix
/// like "Word.Document.8" -> "Word Document".
#[cfg(windows)]
fn prettify_prog_id(prog_id: &str) -> Option<String> {
    let mut s = prog_id.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if let Some(dot) = s.rfind('.') {
        if s[dot + 1..].chars().all(|c| c.is_ascii_digit()) {
            s.truncate(dot);
        }
    }
    if s.is_empty() {
        return None;
    }
    Some(
        s.split(['.', ' '])
            .filter(|p| !p.is_empty())
            .map(|p| {
                let mut c = p.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Resolve a "@file,-resource" indirect string via SHLoadIndirectString.
#[cfg(windows)]
fn resolve_indirect(s: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::SHLoadIndirectString;
    if !s.starts_with('@') {
        return None;
    }
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = [0u16; 512];
    let hr = unsafe {
        SHLoadIndirectString(PCWSTR(wide.as_ptr()), &mut buf, None)
    };
    if hr.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let result = String::from_utf16_lossy(&buf[..len]);
    if result.trim().is_empty() {
        None
    } else {
        Some(result)
    }
}

/// Enumerate the extensions that register a ShellNew entry (Explorer's New
/// submenu content), with the always-present Folder entry first.
#[cfg(windows)]
pub fn shell_new_entries() -> Vec<ShellNewItem> {
    let predef = hcr();
    let mut out: Vec<ShellNewItem> = vec![ShellNewItem {
        label: "Folder".into(),
        ext: String::new(),
        kind: ShellNewKind::Empty,
    }];
    let mut seen: HashSet<String> = HashSet::from(["Folder".to_string()]);

    for sub in predef.enum_keys().filter_map(|k| k.ok()) {
        if !sub.starts_with('.') {
            continue;
        }
        let ext = sub.trim_start_matches('.').to_string();
        if ext.is_empty() || seen.contains(&ext) {
            continue;
        }
        let key = match predef.open_subkey(&sub) {
            Ok(k) => k,
            Err(_) => continue,
        };
        let prog_id: String = key.get_value("").unwrap_or_default();
        // ShellNew lives either on the extension key or on its ProgID.
        let has_sn = key.open_subkey("ShellNew").is_ok()
            || (!prog_id.is_empty()
                && predef
                    .open_subkey(&prog_id)
                    .map(|p| p.open_subkey("ShellNew").is_ok())
                    .unwrap_or(false));
        if !has_sn {
            continue;
        }
        let label = friendly_name(&ext, &prog_id);
        if label.is_empty() || seen.contains(&label) {
            continue;
        }
        seen.insert(ext.clone());
        seen.insert(label.clone());
        out.push(ShellNewItem {
            label,
            ext,
            kind: shell_new_kind(&sub, &prog_id),
        });
    }
    out
}

#[cfg(windows)]
fn shell_new_kind(ext_key_path: &str, prog_id: &str) -> ShellNewKind {
    let predef = hcr();
    let shnew = predef
        .open_subkey(ext_key_path)
        .ok()
        .and_then(|k| k.open_subkey("ShellNew").ok())
        .or_else(|| {
            predef
                .open_subkey(prog_id)
                .ok()
                .and_then(|k| k.open_subkey("ShellNew").ok())
        });
    if let Some(k) = shnew {
        let command: String = k.get_value("Command").unwrap_or_default();
        if !command.trim().is_empty() {
            return ShellNewKind::Command;
        }
        let file_name: String = k.get_value("FileName").unwrap_or_default();
        if !file_name.trim().is_empty() {
            return ShellNewKind::Template;
        }
    }
    ShellNewKind::Empty
}

#[cfg(not(windows))]
pub fn shell_new_entries() -> Vec<ShellNewItem> {
    Vec::new()
}

/// The tauri command: enumerate the New-menu items.
#[tauri::command]
pub fn get_shell_new_items() -> Vec<ShellNewItem> {
    shell_new_entries()
}

/// Materialize a ShellNew item into `parent_dir`, Explorer-style "(n)" dedup.
/// `label` is the menu label used for the default file name.
#[tauri::command]
pub fn create_shell_new_item(parent_dir: String, ext: String, label: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        create_impl(&parent_dir, &ext.to_ascii_lowercase(), &label)
    }
    #[cfg(not(windows))]
    {
        let _ = (parent_dir, ext, label);
        Err("not supported on this platform".into())
    }
}

#[cfg(windows)]
fn create_impl(parent_dir: &str, ext: &str, label: &str) -> Result<String, String> {
    if ext.is_empty() {
        let target = unique_target(parent_dir, "New folder", "");
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        return Ok(target.to_string_lossy().into_owned());
    }

    let predef = hcr();
    let ext_path = format!(".{}", ext);
    let ext_key = predef
        .open_subkey(&ext_path)
        .map_err(|e| format!("no registry entry for .{ext}: {e}"))?;
    let prog_id: String = ext_key.get_value("").unwrap_or_default();

    let shnew = ext_key
        .open_subkey("ShellNew")
        .or_else(|_| predef.open_subkey(format!("{}\\ShellNew", prog_id)))
        .map_err(|_| format!("no ShellNew entry for .{ext}"))?;

    let file_name: String = shnew.get_value("FileName").unwrap_or_default();
    let command: String = shnew.get_value("Command").unwrap_or_default();
    // The rare `Data` variant (registry-embedded bytes) is treated as Empty.

    let default_base = || -> String {
        if label.is_empty() {
            format!("New {}.{}", ext.to_ascii_uppercase(), ext)
        } else {
            format!("New {}", label)
        }
    };

    if !command.trim().is_empty() {
        // Command-style ShellNew (Google Drive, WinRAR). The command takes
        // the destination file path: %1 = target path when FileName is unset
        // (Google: `--new_gsuite_file="%1"` — DriveFS creates the doc itself),
        // %2 = secondary target (WinRAR). A FileName template path replaces
        // %1 when present (WinRAR's `"%1" "%2"` = rarnew.dat + archive).
        let base = unique_target(parent_dir, &default_base(), ext);
        let p1 = if file_name.trim().is_empty() {
            base.to_string_lossy().into_owned()
        } else {
            file_name.trim().to_string()
        };
        let cmd = command
            .replace("%1", &p1)
            .replace("%2", &base.to_string_lossy());
        // cmd /S /C parses a line that both begins with and contains quotes
        // correctly; plain /C strips the outer quotes and breaks the command.
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd")
            .args(["/S", "/C", &cmd])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .map_err(|e| e.to_string())?;
        // DriveFS hands off to the running instance and returns non-zero even
        // on success; only surface failure when the target didn't appear.
        if !status.success() && !base.exists() {
            return Err(format!("creating {label} failed (exit {}) — handler may still be finishing; check the folder", status));
        }
        Ok(base.to_string_lossy().into_owned())
    } else if !file_name.trim().is_empty() {
        let src = PathBuf::from(expand_env(file_name.trim()));
        if !src.is_file() {
            return Err(format!("ShellNew template not found: {file_name}"));
        }
        // Name the copy after the template (minus extension), like Explorer.
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "New file".into());
        let base = unique_target(parent_dir, &stem, ext);
        fs::copy(&src, &base).map_err(|e| e.to_string())?;
        Ok(base.to_string_lossy().into_owned())
    } else {
        let base = unique_target(parent_dir, &default_base(), ext);
        let empty: &[u8] = b"";
        fs::write(&base, empty).map_err(|e| e.to_string())?;
        Ok(base.to_string_lossy().into_owned())
    }
}

/// Expand %VAR% references in a registry path.
#[cfg(windows)]
fn expand_env(s: &str) -> String {
    let mut result = s.to_string();
    for var in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "ProgramFiles", "SystemRoot", "WINDIR"] {
        if let Ok(v) = std::env::var(var) {
            result = result.replace(&format!("%{}%", var), &v);
        }
    }
    result
}

/// "New <base>.<ext>" with Explorer's " (n)" dedup suffix.
#[cfg(windows)]
fn unique_target(parent_dir: &str, base: &str, ext: &str) -> PathBuf {
    let parent = Path::new(parent_dir);
    let mk = |n: usize| -> PathBuf {
        let name = if ext.is_empty() {
            if n == 0 {
                base.to_string()
            } else {
                format!("{base} ({n})")
            }
        } else if n == 0 {
            format!("{base}.{}", ext)
        } else {
            format!("{base} ({n}).{}", ext)
        };
        parent.join(name)
    };
    let mut n = 0;
    let mut t = mk(0);
    while t.exists() {
        n += 1;
        t = mk(n);
    }
    t
}
