use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Drive {
    pub name: String,
    pub path: String,
    /// Volume label from GetVolumeInformationW ("Local Disk", "KINGSTON",
    /// "Google Drive" …); empty when the volume has none.
    pub label: String,
    pub free: String,
    pub total: String,
    pub is_network: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct QuickLink {
    pub name: String,
    pub path: String,
}

/// Open a file or folder with the default Windows application via the `open` crate.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Could not open \"{}\": {}", path, e))
}

/// Open a terminal in the given folder: Windows Terminal when installed,
/// plain cmd.exe otherwise. Never blocks waiting on the child.
#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const NO_WINDOW: u32 = 0x08000000;
    let wt = Command::new("wt")
        .args(["-d", path.as_str()])
        .creation_flags(NO_WINDOW)
        .status();
    match wt {
        Ok(s) if s.success() => Ok(()),
        _ => Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &format!("cd /d \"{path}\"")])
            .creation_flags(NO_WINDOW)
            .status()
            .map(|_| ())
            .map_err(|e| format!("Could not open a terminal in \"{path}\": {e}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ShellVerb {
    pub verb: String,
    pub label: String,
}

/// Registry verbs registered for a given extension under HKCR (.jpg -> e.g.
/// "Edit with Photos" action, "Application\PhotoViewer.dll" verb list etc.).
#[cfg(windows)]
fn registered_verbs(ext: &str) -> Vec<ShellVerb> {
    if ext.is_empty() {
        return Vec::new();
    }
    let Ok(default) = winreg::RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT)
        .open_subkey(&format!(".{}", ext.trim_start_matches('.')))
    else {
        return Vec::new();
    };
    let prog_id: String = default.get_value("").unwrap_or_default();
    if prog_id.is_empty() {
        return Vec::new();
    }
    let hcr = winreg::RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT);
    let Ok(shell_key) = hcr.open_subkey(format!("{}\\shell", prog_id)) else {
        return Vec::new();
    };
    shell_key
        .enum_keys()
        .filter_map(|v| v.ok())
        .filter_map(|verb| {
            let sub = shell_key.open_subkey(&verb).ok()?;
            let label: String = sub.get_value("").unwrap_or_else(|_| verb.clone());
            let command: String = sub.open_subkey("command").ok()?.get_value("").unwrap_or_default();
            if command.is_empty() {
                return None;
            }
            Some(ShellVerb { verb, label })
        })
        .collect()
}

#[cfg(not(windows))]
fn registered_verbs(_ext: &str) -> Vec<ShellVerb> {
    Vec::new()
}

#[tauri::command]
pub fn get_shell_verbs(path: String) -> Vec<ShellVerb> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    registered_verbs(&ext)
}

/// Invoke a saved registry verb for a file ("edit", "print", "openwith"...).
#[tauri::command]
pub fn invoke_shell_verb(path: String, verb: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let res = unsafe {
            ShellExecuteW(
                None,
                &HSTRING::from(&verb),
                &HSTRING::from(&path),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if (res.0 as isize) <= 32 {
            return Err(format!(
                "Could not invoke \"{}\" on \"{}\" (code {})",
                verb, path, res.0 as isize
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (path, verb);
        Err("Not supported on this platform".into())
    }
}

/// Launch the native Windows Open With dialog (`SHOpenWithDialog`) off the UI thread.
#[tauri::command]
pub async fn open_with_dialog(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use windows::core::{HSTRING, PCWSTR};
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{
                SHOpenWithDialog, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OPENASINFO,
            };

            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let file_h = HSTRING::from(&path);
                let info = OPENASINFO {
                    pcszFile: PCWSTR(file_h.as_ptr()),
                    pcszClass: PCWSTR::null(),
                    oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC,
                };
                // S_FALSE / ERROR_CANCELLED happens when user dismisses dialog — not an error toast.
                let _ = SHOpenWithDialog(None, &info);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Not supported on this platform".into())
    }
}

/// Copy a file path as text to the Windows clipboard.
#[tauri::command]
pub fn copy_as_path(paths: Vec<String>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let text = paths.join("\n");
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Set-Clipboard -Value {};", serde_json::json!(text))])
        .creation_flags(0x08000000)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.0} MB", b / MB)
    } else {
        format!("{} bytes", bytes)
    }
}

/// Per-drive details that can stall (dead network drives block these calls
/// for seconds): fetched separately via get_drive_details AFTER the instant
/// get_drives list, so drives always appear immediately.
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DriveDetail {
    pub path: String,
    pub label: String,
    pub free: String,
    pub total: String,
}

/// Capacity + volume label for ONE drive. The caller fires one of these per
/// drive concurrently and merges results as they land — a hung network drive
/// delays only its own row, never the others.
/// Async (`spawn_blocking`) so each drive queries in parallel off the UI thread.
#[tauri::command]
pub async fn get_drive_details(path: String) -> DriveDetail {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{
                GetDiskFreeSpaceExW, GetVolumeInformationW,
            };
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let mut total_bytes: u64 = 0;
            let mut free_bytes: u64 = 0;
            unsafe {
                let _ = GetDiskFreeSpaceExW(
                    PCWSTR(wide.as_ptr()),
                    None,
                    Some(&mut total_bytes),
                    Some(&mut free_bytes),
                );
            }
            // Volume label for Explorer-style "Label (C:)" display names.
            let mut label_buf = [0u16; 256];
            let label = unsafe {
                GetVolumeInformationW(
                    PCWSTR(wide.as_ptr()),
                    Some(&mut label_buf[..]),
                    None,
                    None,
                    None,
                    None,
                )
                .ok()
                .map(|_| {
                    let len = label_buf
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(label_buf.len());
                    String::from_utf16_lossy(&label_buf[..len])
                })
                .unwrap_or_default()
            };
            DriveDetail {
                path,
                label,
                free: format_bytes(free_bytes),
                total: format_bytes(total_bytes),
            }
        })
        .await
        .unwrap_or(DriveDetail {
            path: String::new(),
            label: String::new(),
            free: String::new(),
            total: String::new(),
        })
    }
    #[cfg(not(windows))]
    {
        DriveDetail {
            path,
            label: String::new(),
            free: String::new(),
            total: String::new(),
        }
    }
}

/// Enumerate logical drives — INSTANT by design: letters + type only.
/// Capacity/labels come from get_drive_details afterwards because Windows
/// blocks on unreachable network drives for seconds per call.
/// Async (`spawn_blocking`) so it never waits behind network discovery on the UI thread.
#[tauri::command]
pub async fn get_drives() -> Vec<Drive> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{
                GetDriveTypeW, GetLogicalDriveStringsW,
            };
            const DRIVE_REMOTE: u32 = 4; // from GetDriveTypeW

            let mut buf = [0u16; 1024];
            let len = unsafe { GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
            if len == 0 {
                return Vec::new();
            }
            let letters = &buf[..len];
            let mut drives = Vec::new();
            let mut cur: Vec<u16> = Vec::new();
            for &ch in letters {
                if ch == 0 {
                    if cur.is_empty() {
                        break;
                    }
                    let root = String::from_utf16_lossy(&cur);
                    cur.clear();
                    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                    // GetDriveTypeW is a pure type lookup — no I/O, never blocks.
                    let is_network =
                        unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } == DRIVE_REMOTE;
                    drives.push(Drive {
                        name: root.trim_end_matches('\\').to_string(),
                        path: root.clone(),
                        // Details (label/capacity) stream in via get_drive_details.
                        label: String::new(),
                        free: String::new(),
                        total: String::new(),
                        is_network,
                    });
                } else {
                    cur.push(ch);
                }
            }
            drives
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        vec![Drive {
            name: "/".into(),
            path: "/".into(),
            free: String::new(),
            total: String::new(),
            is_network: false,
        }]
    }
}

const PINS_FILE: &str = "quick-access-pins.json";

/// Live drive hot-plug detection: polls the logical-drive bitmask (a single
/// cheap syscall, no disk I/O so dead network drives can't stall it) and
/// emits `drives-changed` with the new letters list whenever a drive appears
/// or disappears (USB stick plugged/unplugged, network drive mapped, ...).
pub fn spawn_drive_watcher(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        use windows::Win32::Storage::FileSystem::GetLogicalDrives;

        std::thread::spawn(move || {
            let mut last = unsafe { GetLogicalDrives() };
            loop {
                std::thread::sleep(std::time::Duration::from_millis(700));
                let now = unsafe { GetLogicalDrives() };
                if now != last {
                    last = now;
                    let letters: Vec<String> = (0..26u32)
                        .filter(|i| now & (1 << i) != 0)
                        .map(|i| format!("{}:", (b'A' + i as u8) as char))
                        .collect();
                    let _ = app.emit("drives-changed", letters);
                }
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Standard quick-access locations.
#[tauri::command]
pub fn get_quick_access(app: tauri::AppHandle) -> Result<Vec<QuickLink>, String> {
    let home = dirs::home_dir();
    let mut links: Vec<(&str, Option<PathBuf>)> = vec![
        ("Desktop", dirs::desktop_dir()),
        ("Downloads", dirs::download_dir()),
        ("Documents", dirs::document_dir()),
        ("Pictures", dirs::picture_dir()),
        ("Music", home.clone().map(|h| h.join("Music"))),
        ("Videos", home.map(|h| h.join("Videos"))),
    ];
    if let Some(h) = dirs::home_dir() {
        links.insert(0, ("Home", Some(h)));
    }
    let defaults: Vec<QuickLink> = links
        .into_iter()
        .filter_map(|(name, p)| {
            p.filter(|p| p.is_dir()).map(|p| QuickLink {
                name: name.to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect();

    // Store for pinned state.
    let store = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(PINS_FILE);

    let mut out = Vec::new();
    if let Ok(text) = std::fs::read_to_string(&store) {
        // Restore exact pinned order & removals.
        let pins: Vec<Pin> = serde_json::from_str(&text).unwrap_or_default();
        for pin in pins {
            if let Some(l) = defaults.iter().find(|l| l.path == pin.path) {
                out.push(QuickLink { name: l.name.clone(), path: l.path.clone() });
            } else {
                // Custom pins keep their given name
                out.push(QuickLink { name: pin.name, path: pin.path });
            }
        }
    } else {
        out = defaults;
    }
    Ok(out)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Pin {
    name: String,
    path: String,
}

/// Persist quick-access order/removals. `paths` is the complete desired list;
/// anything missing = unpinned. Custom pins come as {name, path}.
#[tauri::command]
pub fn set_quick_access(
    app: tauri::AppHandle,
    links: Vec<QuickLink>,
) -> Result<(), String> {
    use tauri::Emitter;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pins: Vec<Pin> = links
        .iter()
        .map(|l| Pin { name: l.name.clone(), path: l.path.clone() })
        .collect();
    let json = serde_json::to_string(&pins).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(PINS_FILE), json).map_err(|e| e.to_string())?;
    let _ = app.emit("quick-access-changed", &links);
    Ok(())
}

/// Get the system Downloads directory path.
#[tauri::command]
pub fn get_downloads_path() -> Result<String, String> {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Could not determine Downloads folder".into())
}

/// Pin a folder to Quick access (Fast Explorer pins + Windows Shell Quick Access).
#[tauri::command]
pub fn pin_to_quick_access(
    app: tauri::AppHandle,
    name: String,
    path: String,
) -> Result<Vec<QuickLink>, String> {
    use tauri::Emitter;
    let mut current = get_quick_access(app.clone())?;
    let norm_path = path.trim_end_matches(['\\', '/']).to_lowercase();
    if !current.iter().any(|q| q.path.trim_end_matches(['\\', '/']).to_lowercase() == norm_path) {
        current.push(QuickLink {
            name: name.clone(),
            path: path.clone(),
        });
        set_quick_access(app.clone(), current.clone())?;
    }
    let _ = app.emit("quick-access-changed", &current);

    #[cfg(windows)]
    {
        let win_path = path;
        std::thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            let escaped = win_path.replace('\'', "''");
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!(
                        r#"& {{ $sh = New-Object -ComObject Shell.Application; $p = '{}'; $f = $sh.Namespace((Split-Path -Parent $p)); $i = $f.ParseName((Split-Path -Leaf $p)); if ($i) {{ $i.InvokeVerb('pintohome') }} }}"#,
                        escaped
                    ),
                ])
                .creation_flags(0x08000000)
                .status();
        });
    }

    Ok(current)
}

/// Unpin a folder from Quick access (Fast Explorer pins + Windows Shell Quick Access).
#[tauri::command]
pub fn unpin_from_quick_access(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<QuickLink>, String> {
    use tauri::Emitter;
    let current = get_quick_access(app.clone())?;
    let norm_path = path.trim_end_matches(['\\', '/']).to_lowercase();
    let updated: Vec<QuickLink> = current
        .into_iter()
        .filter(|q| q.path.trim_end_matches(['\\', '/']).to_lowercase() != norm_path)
        .collect();
    set_quick_access(app.clone(), updated.clone())?;
    let _ = app.emit("quick-access-changed", &updated);

    #[cfg(windows)]
    {
        let win_path = path;
        std::thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            let escaped = win_path.replace('\'', "''");
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!(
                        r#"& {{ $sh = New-Object -ComObject Shell.Application; $target = '{}'; $qa = $sh.Namespace('shell:::{{679f85cb-0220-4080-b29b-5540cc05aab6}}'); if ($qa) {{ foreach ($x in $qa.Items()) {{ if ($x.Path -eq $target) {{ foreach ($v in $x.Verbs()) {{ if ($v.Name -match 'Unpin') {{ $v.DoIt(); break }} }} }} }} }} }}"#,
                        escaped
                    ),
                ])
                .creation_flags(0x08000000)
                .status();
        });
    }

    Ok(updated)
}

/// Discover active non-loopback local IPv4 addresses via UDP connect routing probes (< 1ms).
/// Ensures SSDP multicast M-SEARCH is transmitted on real LAN adapters (e.g. Wi-Fi / Ethernet)
/// even when Hyper-V virtual switches or VPN tunnels (NordLynx, WireGuard) own the default route.
#[cfg_attr(not(windows), allow(dead_code))]
fn local_lan_ipv4s() -> Vec<std::net::Ipv4Addr> {
    use std::net::{Ipv4Addr, UdpSocket};
    let mut ips: Vec<Ipv4Addr> = Vec::new();
    let mut probe = |target: Ipv4Addr| {
        if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
            if s.connect((target, 80)).is_ok() {
                if let Ok(std::net::SocketAddr::V4(local)) = s.local_addr() {
                    let ip = *local.ip();
                    if !ip.is_loopback() && !ip.is_unspecified() && !ips.contains(&ip) {
                        ips.push(ip);
                    }
                }
            }
        }
    };
    for sub in 0..=255u8 {
        probe(Ipv4Addr::new(192, 168, sub, 1));
    }
    for sub in [0u8, 1, 5, 8, 10, 20, 50, 100] {
        probe(Ipv4Addr::new(10, sub, 0, 1));
    }
    for sub in 16..=31u8 {
        probe(Ipv4Addr::new(172, sub, 0, 1));
    }
    probe(Ipv4Addr::new(8, 8, 8, 8));
    ips
}

/// Probe dynamic ARP table neighbors on local 192.168.x.0/24 subnets for port-80 UPnP
/// `/description.xml` endpoints (catches devices like Philips Hue Bridge that disable SSDP
/// UDP replies in newer firmware but advertise UPnP root descriptions over HTTP).
#[cfg_attr(not(windows), allow(dead_code))]
fn arp_neighbor_urls(local_ips: &[std::net::Ipv4Addr]) -> Vec<String> {
    let mut urls = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let prefixes: Vec<[u8; 3]> = local_ips
            .iter()
            .map(|ip| ip.octets())
            .filter(|o| o[0] == 192 && o[1] == 168)
            .map(|o| [o[0], o[1], o[2]])
            .collect();
        if prefixes.is_empty() {
            return urls;
        }
        if let Ok(out) = std::process::Command::new("arp")
            .arg("-a")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[2].eq_ignore_ascii_case("dynamic") {
                    if let Ok(ip) = parts[0].parse::<std::net::Ipv4Addr>() {
                        let o = ip.octets();
                        if o[3] != 255
                            && !local_ips.contains(&ip)
                            && prefixes.contains(&[o[0], o[1], o[2]])
                        {
                            urls.push(format!("http://{ip}:80/description.xml"));
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = local_ips;
    }
    urls
}

/// Minimal SSDP/UPnP discovery (stdlib only, no extra deps): M-SEARCH across all
/// active local IPv4 interfaces for `ssdp:all` + `upnp:rootdevice` using the mandatory
/// `MAN: "ssdp:discover"` header, plus ARP neighbor `/description.xml` probes, then
/// fetch each description XML concurrently for its friendly name and device category.
#[cfg_attr(not(windows), allow(dead_code))]
fn ssdp_discover() -> Vec<(String, String, String)> {
    use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
    use std::time::{Duration, Instant};

    let local_ips = local_lan_ipv4s();
    let mut bind_ips = local_ips.clone();
    if bind_ips.is_empty() {
        bind_ips.push(Ipv4Addr::UNSPECIFIED);
    }

    let mut sockets: Vec<UdpSocket> = Vec::new();
    for ip in &bind_ips {
        if let Ok(s) = UdpSocket::bind(SocketAddrV4::new(*ip, 0)) {
            let _ = s.set_multicast_loop_v4(true);
            let _ = s.set_nonblocking(true);
            sockets.push(s);
        }
    }
    if sockets.is_empty() {
        return Vec::new();
    }

    let packets = [
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n",
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: upnp:rootdevice\r\n\r\n",
    ];
    let broadcast = |socks: &[UdpSocket]| {
        for s in socks {
            for pkt in &packets {
                let _ = s.send_to(pkt.as_bytes(), "239.255.255.250:1900");
            }
        }
    };
    broadcast(&sockets);

    let start = Instant::now();
    let deadline = start + Duration::from_millis(950);
    let mut resent = false;
    let mut seen: Vec<String> = Vec::new();
    let mut buf = [0u8; 8192];

    while Instant::now() < deadline {
        if !resent && start.elapsed() >= Duration::from_millis(320) {
            resent = true;
            broadcast(&sockets);
        }
        let mut any_packet = false;
        for s in &sockets {
            while let Ok((n, _)) = s.recv_from(&mut buf) {
                any_packet = true;
                let text = String::from_utf8_lossy(&buf[..n]);
                let mut loc = String::new();
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once(':') {
                        if k.trim().eq_ignore_ascii_case("location") {
                            loc = v.trim().to_string();
                            break;
                        }
                    }
                }
                if !loc.is_empty() && !seen.iter().any(|u| u.eq_ignore_ascii_case(&loc)) {
                    seen.push(loc);
                }
            }
        }
        if !any_packet {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    for arp_url in arp_neighbor_urls(&local_ips) {
        if !seen.iter().any(|u| u.eq_ignore_ascii_case(&arp_url)) {
            seen.push(arp_url);
        }
    }

    let mut found: Vec<(String, String, String)> = Vec::new();
    std::thread::scope(|s| {
        let handles: Vec<_> = seen
            .into_iter()
            .map(|loc| s.spawn(move || fetch_upnp_description(&loc)))
            .collect();
        for h in handles {
            if let Ok(Some((name, dtype, target))) = h.join() {
                found.push((name, target, dtype));
            }
        }
    });
    found
}

/// Decode standard XML entities in UPnP friendlyName strings (e.g. `55&quot; Crystal UHD`).
fn decode_xml_entities(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Extract the HTTP body and decode `Transfer-Encoding: chunked` if present
/// (Sonos/SYMFONISK speakers respond with HTTP/1.1 chunked encoding even to HTTP/1.0 requests).
fn decode_http_body(resp: &str) -> String {
    let (headers, body) = match resp.find("\r\n\r\n") {
        Some(i) => (&resp[..i], &resp[i + 4..]),
        None => return resp.to_string(),
    };
    let is_chunked = headers.lines().any(|line| {
        if let Some((k, v)) = line.split_once(':') {
            k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
        } else {
            false
        }
    });
    if !is_chunked {
        return body.to_string();
    }
    let bytes = body.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut pos = 0;
    while pos < bytes.len() {
        let Some(rel_end) = bytes[pos..].windows(2).position(|w| w == b"\r\n") else {
            out.extend_from_slice(&bytes[pos..]);
            break;
        };
        let line = std::str::from_utf8(&bytes[pos..pos + rel_end]).unwrap_or("");
        let hex = line.split(';').next().unwrap_or("").trim();
        let Ok(chunk_len) = usize::from_str_radix(hex, 16) else {
            out.extend_from_slice(&bytes[pos..]);
            break;
        };
        pos += rel_end + 2;
        if chunk_len == 0 {
            break;
        }
        let end = (pos + chunk_len).min(bytes.len());
        out.extend_from_slice(&bytes[pos..end]);
        pos = end;
        if bytes.get(pos..pos + 2) == Some(b"\r\n") {
            pos += 2;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Fetch a UPnP device description XML with a hand-rolled HTTP/1.0 GET.
/// Returns (friendly_name, device_type, open_target); open_target prefers
/// presentationURL and falls back to the description URL itself.
#[cfg_attr(not(windows), allow(dead_code))]
fn fetch_upnp_description(url: &str) -> Option<(String, String, String)> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let rest = url.strip_prefix("http://")?;
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let addr = host_port.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(450)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut resp = Vec::new();
    let _ = stream.take(256 * 1024).read_to_end(&mut resp);
    if resp.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&resp);
    let xml_owned = decode_http_body(&text);
    let xml = xml_owned.as_str();
    let raw_dtype = xml_tag(xml, "deviceType").filter(|d| !d.is_empty())?;
    let raw_name = xml_tag(xml, "friendlyName").filter(|n| !n.is_empty())?;
    let decoded = decode_xml_entities(&raw_name);
    let flat: String = decoded.chars().filter(|c| !c.is_control()).collect();
    let name = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.trim().to_string();
    if name.is_empty() || name.starts_with("InternetGatewayDevice") {
        return None;
    }
    let name = if name.chars().count() > 80 {
        format!("{}…", name.chars().take(79).collect::<String>())
    } else {
        name
    };
    // Classify Sonos ZonePlayers and nested MediaRenderer/MediaServer descriptions
    // under "MediaDevice" to match Windows Explorer's "Media Devices" group.
    let xml_lower = xml.to_ascii_lowercase();
    let dtype_lower = raw_dtype.to_ascii_lowercase();
    let dtype = if dtype_lower.contains("mediaserver")
        || dtype_lower.contains("mediarenderer")
        || dtype_lower.contains("zoneplayer")
        || xml_lower.contains(":mediarenderer:")
        || xml_lower.contains(":mediaserver:")
    {
        "MediaDevice".to_string()
    } else {
        raw_dtype
    };
    let target = xml_tag(xml, "presentationURL")
        .filter(|u| !u.is_empty())
        .map(|u| {
            if u.starts_with("http://") || u.starts_with("https://") {
                u
            } else if u.starts_with('/') {
                format!("http://{host_port}{u}")
            } else {
                format!("http://{host_port}/{u}")
            }
        })
        .unwrap_or_else(|| url.to_string());
    Some((name, dtype, target))
}

/// First occurrence of <tag>…</tag> (case-sensitive, matching the spec).
fn xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = xml.find(&open)? + open.len();
    let e = xml[s..].find(&close)?;
    Some(xml[s..s + e].trim().to_string())
}

/// Short Explorer-compatible category from a UPnP deviceType URN.
fn short_device_type(dtype: &str) -> String {
    let d = dtype.to_ascii_lowercase();
    if d.contains("mediaserver")
        || d.contains("mediarenderer")
        || d.contains("zoneplayer")
        || d.contains("mediadevice")
    {
        "Media Device".to_string()
    } else if d.contains("printer") {
        "Printer".to_string()
    } else if d.contains("camera") {
        "Camera".to_string()
    } else {
        "Other Device".to_string()
    }
}

/// Enumerate machines and UPnP/DLNA devices on the local network asynchronously.
/// WNet enumeration and SSDP/UPnP discovery run concurrently on worker threads
/// so neither blocks the Tauri UI thread or each other.
#[cfg(windows)]
#[tauri::command]
pub async fn list_network_hosts() -> Result<Vec<crate::commands::fs_ops::FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(list_network_hosts_sync)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn list_network_hosts_sync() -> Result<Vec<crate::commands::fs_ops::FsEntry>, String> {
    let mut devices = ssdp_discover();
    let mut entries: Vec<crate::commands::fs_ops::FsEntry> = Vec::new();

    // Sort Media Devices first, then Other Devices, alphabetically within each group
    // (matches Windows Explorer's Network view ordering).
    devices.sort_by(|a, b| {
        let cat_a = short_device_type(&a.2);
        let cat_b = short_device_type(&b.2);
        cat_a
            .cmp(&cat_b)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    for (name, url, dtype) in devices {
        let category = short_device_type(&dtype);
        // Deduplicate by (name, category) so devices advertising both a MediaRenderer
        // and an Other Device profile (e.g. "55\" Crystal UHD") appear in both roles
        // just like Windows Explorer, while duplicate root descriptions collapse.
        if entries.iter().any(|e| {
            e.name.eq_ignore_ascii_case(&name) && e.item_type.eq_ignore_ascii_case(&category)
        }) {
            continue;
        }
        entries.push(crate::commands::fs_ops::FsEntry {
            name,
            path: format!("upnp::{url}"),
            is_dir: true,
            is_hidden: false,
            size: String::new(),
            item_type: category,
            modified: String::new(),
        });
    }
    Ok(entries)
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn list_network_hosts() -> Result<Vec<crate::commands::fs_ops::FsEntry>, String> {
    Ok(Vec::new())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn downloads_path_resolves() {
        let p = get_downloads_path().expect("should find downloads path");
        assert!(!p.is_empty());
        assert!(std::path::Path::new(&p).exists());
    }

    #[test]
    fn network_discovery_finds_lan_devices() {
        let ips = local_lan_ipv4s();
        eprintln!("local_lan_ipv4s: {ips:?}");
        assert!(!ips.is_empty(), "should detect at least one local IPv4 address");
        let hosts = list_network_hosts_sync().expect("list_network_hosts_sync should succeed");
        for h in &hosts {
            eprintln!("discovered: [{}] {} -> {}", h.item_type, h.name, h.path);
        }
    }
}
