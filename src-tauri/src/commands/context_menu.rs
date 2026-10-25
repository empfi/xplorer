use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::State;

/// One item or submenu inside a native/hybrid shell context menu group.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenuItem {
    /// Clean display label (accelerators stripped).
    pub label: String,
    /// Optional right-aligned shortcut text (e.g. "Ctrl+Z").
    pub shortcut: Option<String>,
    /// Optional 16x16 PNG data URL extracted from menu bitmap or registry icon.
    pub icon: Option<String>,
    /// Canonical shell verb ("open", "cut", "copy", "paste", "delete", "rename", "properties", "link", ...).
    pub verb: Option<String>,
    /// Zero-based command offset for `IContextMenu::InvokeCommand` (`None` for submenus or registry commands).
    pub cmd_id: Option<u32>,
    /// Direct shell command template for `Directory\Background\shell` entries.
    pub command: Option<String>,
    /// Bold default item in Explorer.
    pub primary: bool,
    /// Grayed/disabled item.
    pub disabled: bool,
    /// Nested submenu groups (separated by horizontal dividers).
    pub submenu: Vec<Vec<ShellMenuItem>>,
}

/// Complete response for a right-click context menu query.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellContextMenuResponse {
    pub session_id: u64,
    pub groups: Vec<Vec<ShellMenuItem>>,
}

#[cfg(windows)]
enum MenuStaRequest {
    QueryItems {
        paths: Vec<String>,
        shift: bool,
        reply: Sender<Result<ShellContextMenuResponse, String>>,
    },
    QueryBackground {
        dir_path: String,
        shift: bool,
        reply: Sender<Result<ShellContextMenuResponse, String>>,
    },
    Invoke {
        session_id: u64,
        cmd_id: u32,
        pt_x: i32,
        pt_y: i32,
        dir_hint: Option<String>,
        hwnd: isize,
        reply: Sender<Result<(), String>>,
    },
}

#[cfg(windows)]
struct PropStaRequest {
    paths: Vec<String>,
    page: Option<String>,
    reply: Sender<Result<(), String>>,
}

/// Dedicated STA worker channel backed by a real Win32 `MsgWaitForMultipleObjects`
/// message pump (`QS_ALLINPUT`), so COM marshaling and modeless shell dialogs
/// dispatch immediately with 0% idle CPU and zero main-thread blocking.
#[cfg(windows)]
struct StaChannel<Req: Send + 'static> {
    tx: Mutex<Option<Sender<Req>>>,
    thread_id: u32,
}

#[cfg(windows)]
impl<Req: Send + 'static> StaChannel<Req> {
    fn spawn<H>(
        name: &str,
        init: impl FnOnce() + Send + 'static,
        make_handler: impl FnOnce() -> H + Send + 'static,
    ) -> Self
    where
        H: FnMut(Req) + 'static,
    {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage, MSG,
            PM_NOREMOVE, PM_REMOVE, QS_ALLINPUT,
        };

        let (tx, rx) = mpsc::channel::<Req>();
        let (tid_tx, tid_rx) = mpsc::channel::<u32>();

        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

                // Force creation of this thread's Win32 message queue before publishing `thread_id`.
                let mut init_msg = MSG::default();
                let _ = PeekMessageW(&mut init_msg, None, 0, 0, PM_NOREMOVE);
                let _ = tid_tx.send(GetCurrentThreadId());

                let pump_messages = || {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).into() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                };

                let mut handle_req = make_handler();
                pump_messages();
                init();
                pump_messages();

                loop {
                    pump_messages();

                    loop {
                        match rx.try_recv() {
                            Ok(req) => {
                                handle_req(req);
                                pump_messages();
                            }
                            Err(mpsc::TryRecvError::Empty) => break,
                            Err(mpsc::TryRecvError::Disconnected) => return,
                        }
                    }

                    let _ = MsgWaitForMultipleObjects(None, false, u32::MAX, QS_ALLINPUT);
                }
            })
            .expect("failed to spawn shell STA worker");

        let thread_id = tid_rx.recv().expect("shell STA worker failed to start");

        Self {
            tx: Mutex::new(Some(tx)),
            thread_id,
        }
    }

    fn send(&self, req: Req) -> Result<(), String> {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_NULL};

        let guard = self
            .tx
            .lock()
            .map_err(|_| "shell STA channel poisoned".to_string())?;
        let tx = guard
            .as_ref()
            .ok_or_else(|| "shell STA worker shut down".to_string())?;
        tx.send(req).map_err(|e| e.to_string())?;
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_NULL, WPARAM(0), LPARAM(0));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl<Req: Send + 'static> Drop for StaChannel<Req> {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_NULL};

        if let Ok(mut guard) = self.tx.lock() {
            let _ = guard.take();
        }
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_NULL, WPARAM(0), LPARAM(0));
        }
    }
}

pub struct ContextMenuState {
    #[cfg(windows)]
    menu_sta: StaChannel<MenuStaRequest>,
    #[cfg(windows)]
    prop_sta: StaChannel<PropStaRequest>,
}

impl Default for ContextMenuState {
    fn default() -> Self {
        #[cfg(windows)]
        {
            let menu_sta = StaChannel::spawn(
                "shell-context-menu-sta",
                || unsafe { warm_sta_shell_extensions() },
                || {
                    let mut next_session_id: u64 = 1;
                    let mut sessions: VecDeque<ActiveMenuSession> = VecDeque::with_capacity(6);
                    move |req| match req {
                        MenuStaRequest::QueryItems {
                            paths,
                            shift,
                            reply,
                        } => {
                            let sid = next_session_id;
                            next_session_id += 1;
                            match unsafe { build_items_menu(sid, &paths, shift) } {
                                Ok((resp, sess)) => {
                                    push_session(&mut sessions, sess);
                                    let _ = reply.send(Ok(resp));
                                }
                                Err(e) => {
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                        MenuStaRequest::QueryBackground {
                            dir_path,
                            shift,
                            reply,
                        } => {
                            let sid = next_session_id;
                            next_session_id += 1;
                            match unsafe { build_background_menu(sid, &dir_path, shift) } {
                                Ok((resp, sess)) => {
                                    if let Some(s) = sess {
                                        push_session(&mut sessions, s);
                                    }
                                    let _ = reply.send(Ok(resp));
                                }
                                Err(e) => {
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                        MenuStaRequest::Invoke {
                            session_id,
                            cmd_id,
                            pt_x,
                            pt_y,
                            dir_hint,
                            hwnd,
                            reply,
                        } => {
                            let res =
                                if let Some(sess) = sessions.iter().find(|s| s.id == session_id) {
                                    unsafe {
                                        invoke_icm_cmd(
                                            &sess.icm,
                                            cmd_id,
                                            pt_x,
                                            pt_y,
                                            dir_hint.as_deref(),
                                            windows::Win32::Foundation::HWND(hwnd as *mut std::ffi::c_void),
                                        )
                                    }
                                } else {
                                    Err("Context menu session expired".into())
                                };
                            let _ = reply.send(res);
                        }
                    }
                },
            );

            let prop_sta = StaChannel::spawn(
                "shell-properties-sta",
                || {},
                || {
                    let mut prop_sessions: VecDeque<ActiveMenuSession> = VecDeque::with_capacity(6);
                    move |req: PropStaRequest| {
                        let res = unsafe {
                            show_properties_sta(&req.paths, req.page.as_deref(), &mut prop_sessions)
                        };
                        let _ = req.reply.send(res);
                    }
                },
            );

            Self { menu_sta, prop_sta }
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }
}

/// Query the full Windows Shell `IContextMenu` tree (including third-party
/// shell extensions like WinRAR, 7-Zip, NordVPN, Defender, Send To, Open With)
/// for one or more filesystem items.
/// Async so Tauri's main Win32 UI thread never blocks on COM/shell extensions.
#[tauri::command]
pub async fn query_shell_context_menu(
    paths: Vec<String>,
    shift: bool,
    state: State<'_, ContextMenuState>,
) -> Result<ShellContextMenuResponse, String> {
    #[cfg(windows)]
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        state.menu_sta.send(MenuStaRequest::QueryItems {
            paths,
            shift,
            reply: reply_tx,
        })?;
        tauri::async_runtime::spawn_blocking(move || reply_rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, shift, state);
        Ok(ShellContextMenuResponse {
            session_id: 0,
            groups: Vec::new(),
        })
    }
}

/// Query folder-background integrations (`Directory\Background\shell` entries
/// like Visual Studio, Warp, Windows Terminal, VS Code, Git, plus background
/// COM shell extensions).
#[tauri::command]
pub async fn query_background_shell_menu(
    dir_path: String,
    shift: bool,
    state: State<'_, ContextMenuState>,
) -> Result<ShellContextMenuResponse, String> {
    #[cfg(windows)]
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        state.menu_sta.send(MenuStaRequest::QueryBackground {
            dir_path,
            shift,
            reply: reply_tx,
        })?;
        tauri::async_runtime::spawn_blocking(move || reply_rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        let _ = (dir_path, shift, state);
        Ok(ShellContextMenuResponse {
            session_id: 0,
            groups: Vec::new(),
        })
    }
}

/// Invoke a command ID from the active `IContextMenu` session on the STA thread.
#[tauri::command]
pub async fn invoke_shell_context_item(
    window: tauri::Window,
    session_id: u64,
    cmd_id: u32,
    pt_x: i32,
    pt_y: i32,
    dir_hint: Option<String>,
    state: State<'_, ContextMenuState>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        let hwnd_val: isize = window.hwnd().map(|h| h.0 as isize).unwrap_or_else(|_| {
            let fg = unsafe { GetForegroundWindow() };
            fg.0 as isize
        });

        let (reply_tx, reply_rx) = mpsc::channel();
        state.menu_sta.send(MenuStaRequest::Invoke {
            session_id,
            cmd_id,
            pt_x,
            pt_y,
            dir_hint,
            hwnd: hwnd_val,
            reply: reply_tx,
        })?;
        tauri::async_runtime::spawn_blocking(move || reply_rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        let _ = (window, session_id, cmd_id, pt_x, pt_y, dir_hint, state);
        Err("Not supported on this platform".into())
    }
}

/// Run a `Directory\Background\shell` command template (substituting `%V`/`%1`).
#[tauri::command]
pub fn invoke_background_command(dir_path: String, command: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        run_background_command_impl(&dir_path, &command)
    }
    #[cfg(not(windows))]
    {
        let _ = (dir_path, command);
        Err("Not supported on this platform".into())
    }
}

/// Open the native Windows Properties dialog (optionally targeting a specific tab
/// such as `"Customize"` for "Customise this folder...").
/// Runs asynchronously against `shell-properties-sta` with `HWND::default()` so it
/// can never deadlock Tauri's main UI window thread via cross-thread `SendMessage`.
#[tauri::command]
pub async fn show_properties(
    paths: Vec<String>,
    page: Option<String>,
    state: State<'_, ContextMenuState>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        state.prop_sta.send(PropStaRequest {
            paths,
            page,
            reply: reply_tx,
        })?;
        tauri::async_runtime::spawn_blocking(move || reply_rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, page, state);
        Err("Not supported on this platform".into())
    }
}

/// Create Windows `.lnk` shortcut(s) alongside the source item (or in `dest_dir`).
#[tauri::command]
pub async fn create_shortcut(
    paths: Vec<String>,
    dest_dir: Option<String>,
) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use windows::core::{Interface, HSTRING};
            use windows::Win32::System::Com::{
                CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            };
            use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            let mut created = Vec::new();
            for src in paths {
                let src_path = Path::new(&src);
                if !src_path.exists() {
                    continue;
                }
                let parent = dest_dir
                    .as_deref()
                    .map(PathBuf::from)
                    .or_else(|| src_path.parent().map(Path::to_path_buf))
                    .ok_or_else(|| format!("Cannot determine target folder for {src}"))?;
                let base_name = src_path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Item".into());
                let mut n = 0usize;
                let mut lnk = parent.join(format!("{base_name} - Shortcut.lnk"));
                while lnk.exists() {
                    n += 1;
                    lnk = parent.join(format!("{base_name} - Shortcut ({}).lnk", n + 1));
                }
                unsafe {
                    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| e.to_string())?;
                    link.SetPath(&HSTRING::from(&src))
                        .map_err(|e| e.to_string())?;
                    if let Some(work_dir) = src_path.parent() {
                        let _ = link.SetWorkingDirectory(&HSTRING::from(
                            work_dir.to_string_lossy().as_ref(),
                        ));
                    }
                    let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
                    persist
                        .Save(&HSTRING::from(lnk.to_string_lossy().as_ref()), true)
                        .map_err(|e| e.to_string())?;
                }
                created.push(lnk.to_string_lossy().into_owned());
            }
            Ok(created)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, dest_dir);
        Err("Not supported on this platform".into())
    }
}

#[cfg(windows)]
struct ActiveMenuSession {
    id: u64,
    icm: windows::Win32::UI::Shell::IContextMenu,
    hmenu: windows::Win32::UI::WindowsAndMessaging::HMENU,
}

#[cfg(windows)]
impl Drop for ActiveMenuSession {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyMenu(self.hmenu);
        }
    }
}

#[cfg(windows)]
fn push_session(sessions: &mut VecDeque<ActiveMenuSession>, sess: ActiveMenuSession) {
    const MAX_SESSIONS: usize = 6;
    sessions.push_back(sess);
    while sessions.len() > MAX_SESSIONS {
        sessions.pop_front();
    }
}

/// Pre-load COM shell extension DLLs and populate menu icon / registry caches on
/// the background STA thread so the user's very first right-click is already hot.
#[cfg(windows)]
unsafe fn warm_sta_shell_extensions() {
    let _ = collect_registry_background_verbs("C:\\", false);
    let _ = collect_registry_background_verbs("C:\\", true);
    if let Ok(sysroot) = std::env::var("SystemRoot") {
        let probe_file = Path::new(&sysroot).join("notepad.exe");
        if probe_file.exists() {
            let _ = build_items_menu(0, &[probe_file.to_string_lossy().into_owned()], false);
        }
        let _ = build_background_menu(0, &sysroot, false);
    }
}

#[cfg(windows)]
unsafe fn build_items_menu(
    session_id: u64,
    paths: &[String],
    shift: bool,
) -> Result<(ShellContextMenuResponse, ActiveMenuSession), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        BHID_SFUIObject, IContextMenu, IShellItemArray, SHCreateShellItemArrayFromIDLists,
        SHParseDisplayName, CMF_CANRENAME, CMF_EXPLORE, CMF_EXTENDEDVERBS, CMF_NORMAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::CreatePopupMenu;

    if paths.is_empty() {
        return Err("No items selected".into());
    }

    let mut pidls: Vec<*mut ITEMIDLIST> = Vec::with_capacity(paths.len());
    for p in paths {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        if SHParseDisplayName(&HSTRING::from(p.as_str()), None, &mut pidl, 0, None).is_ok()
            && !pidl.is_null()
        {
            pidls.push(pidl);
        }
    }
    if pidls.is_empty() {
        return Err("Could not parse shell item(s)".into());
    }

    let pidl_consts: Vec<*const ITEMIDLIST> = pidls.iter().map(|&p| p as *const ITEMIDLIST).collect();
    let array_res: Result<IShellItemArray, _> = SHCreateShellItemArrayFromIDLists(&pidl_consts);
    for p in pidls {
        CoTaskMemFree(Some(p as *const _));
    }
    let array = array_res.map_err(|e| format!("Shell item array failed: {e}"))?;

    let icm: IContextMenu = array
        .BindToHandler(None, &BHID_SFUIObject)
        .map_err(|e| format!("BindToHandler(IContextMenu) failed: {e}"))?;

    let hmenu = CreatePopupMenu().map_err(|e| e.to_string())?;
    let mut flags = CMF_NORMAL | CMF_EXPLORE | CMF_CANRENAME;
    if shift {
        flags |= CMF_EXTENDEDVERBS;
    }

    let hr = icm.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags);
    if hr.is_err() {
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyMenu(hmenu);
        return Err(format!("QueryContextMenu failed: {:?}", hr));
    }

    let groups = extract_menu_groups(&icm, hmenu, 0);
    let sess = ActiveMenuSession {
        id: session_id,
        icm,
        hmenu,
    };
    Ok((
        ShellContextMenuResponse { session_id, groups },
        sess,
    ))
}

#[cfg(windows)]
unsafe fn build_background_menu(
    session_id: u64,
    dir_path: &str,
    shift: bool,
) -> Result<(ShellContextMenuResponse, Option<ActiveMenuSession>), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        BHID_SFObject, IContextMenu, IShellFolder, IShellItem, SHCreateItemFromParsingName,
        CMF_EXTENDEDVERBS, CMF_NORMAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::CreatePopupMenu;

    let mut groups: Vec<Vec<ShellMenuItem>> = Vec::new();
    let reg_items = collect_registry_background_verbs(dir_path, shift);
    if !reg_items.is_empty() {
        groups.push(reg_items);
    }

    let mut session: Option<ActiveMenuSession> = None;
    if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(dir_path), None)
    {
        if let Ok(folder) = item.BindToHandler::<_, IShellFolder>(None, &BHID_SFObject) {
            if let Ok(icm) = folder.CreateViewObject::<IContextMenu>(HWND::default()) {
                if let Ok(hmenu) = CreatePopupMenu() {
                    let mut flags = CMF_NORMAL;
                    if shift {
                        flags |= CMF_EXTENDEDVERBS;
                    }
                    if icm.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags).is_ok() {
                        let com_groups = extract_menu_groups(&icm, hmenu, 0);
                        let seen: HashSet<String> = groups
                            .iter()
                            .flatten()
                            .map(|i| i.label.to_lowercase())
                            .collect();
                        for g in com_groups {
                            let filtered: Vec<ShellMenuItem> = g
                                .into_iter()
                                .filter(|i| {
                                    let low = i.label.to_lowercase();
                                    // `New` is handled by Fast Explorer's inline-rename ShellNew submenu.
                                    low != "new"
                                        && !seen.contains(&low)
                                        && !matches!(
                                            i.verb.as_deref(),
                                            Some("paste") | Some("paste_link") | Some("properties")
                                        )
                                })
                                .collect();
                            if !filtered.is_empty() {
                                groups.push(filtered);
                            }
                        }
                        session = Some(ActiveMenuSession {
                            id: session_id,
                            icm,
                            hmenu,
                        });
                    } else {
                        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyMenu(hmenu);
                    }
                }
            }
        }
    }

    Ok((
        ShellContextMenuResponse { session_id, groups },
        session,
    ))
}

#[cfg(windows)]
unsafe fn extract_menu_groups(
    icm: &windows::Win32::UI::Shell::IContextMenu,
    hmenu: windows::Win32::UI::WindowsAndMessaging::HMENU,
    depth: u32,
) -> Vec<Vec<ShellMenuItem>> {
    use windows::core::{Interface, PSTR, PWSTR};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Shell::{IContextMenu2, IContextMenu3, GCS_VERBW};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMenuItemCount, GetMenuItemInfoW, MENUITEMINFOW, MFS_DEFAULT, MFS_DISABLED, MFS_GRAYED,
        MFT_OWNERDRAW, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
        MIIM_SUBMENU, WM_INITMENUPOPUP,
    };

    if depth > 3 {
        return Vec::new();
    }

    let count = GetMenuItemCount(Some(hmenu));
    if count <= 0 {
        return Vec::new();
    }

    let icm3 = icm.cast::<IContextMenu3>().ok();
    let icm2 = icm.cast::<IContextMenu2>().ok();

    let mut groups: Vec<Vec<ShellMenuItem>> = Vec::new();
    let mut cur: Vec<ShellMenuItem> = Vec::new();

    for i in 0..(count as u32) {
        let mut text_buf = [0u16; 512];
        let mut mii = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_STRING | MIIM_SUBMENU | MIIM_BITMAP,
            dwTypeData: PWSTR(text_buf.as_mut_ptr()),
            cch: text_buf.len() as u32,
            ..Default::default()
        };
        if GetMenuItemInfoW(hmenu, i, true, &mut mii).is_err() {
            continue;
        }

        if (mii.fType.0 & MFT_SEPARATOR.0) != 0 {
            if !cur.is_empty() {
                groups.push(std::mem::take(&mut cur));
            }
            continue;
        }

        let raw_len = (mii.cch as usize).min(text_buf.len());
        let raw_label = String::from_utf16_lossy(&text_buf[..raw_len]);
        let (label, shortcut) = clean_menu_label(&raw_label);
        if label.is_empty() {
            // Pure owner-drawn item with no text representation
            let _ = MFT_OWNERDRAW;
            continue;
        }

        let has_sub = !mii.hSubMenu.is_invalid() && !mii.hSubMenu.0.is_null();
        let mut submenu = Vec::new();
        if has_sub && depth < 2 {
            // Notify dynamic submenu handlers (Send To, Open With, 7-Zip, WinRAR) to populate items.
            if let Some(ref c3) = icm3 {
                let _ = c3.HandleMenuMsg2(
                    WM_INITMENUPOPUP,
                    WPARAM(mii.hSubMenu.0 as usize),
                    LPARAM(i as isize),
                    None,
                );
            } else if let Some(ref c2) = icm2 {
                let _ = c2.HandleMenuMsg(
                    WM_INITMENUPOPUP,
                    WPARAM(mii.hSubMenu.0 as usize),
                    LPARAM(i as isize),
                );
            }
            submenu = extract_menu_groups(icm, mii.hSubMenu, depth + 1);
            // If an owner-drawn submenu produced zero readable items, skip empty container
            if submenu.is_empty() {
                continue;
            }
        }

        let cmd_id = if !has_sub && mii.wID >= 1 && mii.wID <= 0x7FFF {
            Some(mii.wID - 1)
        } else {
            None
        };

        let verb = cmd_id.and_then(|cid| {
            let mut vbuf = [0u16; 128];
            let hr = icm.GetCommandString(
                cid as usize,
                GCS_VERBW,
                None,
                PSTR(vbuf.as_mut_ptr() as *mut u8),
                vbuf.len() as u32,
            );
            if hr.is_ok() {
                let end = vbuf.iter().position(|&c| c == 0).unwrap_or(0);
                let s = String::from_utf16_lossy(&vbuf[..end]).trim().to_lowercase();
                if !s.is_empty() {
                    return Some(s);
                }
            }
            None
        });

        let icon = if !mii.hbmpItem.is_invalid() && (mii.hbmpItem.0 as usize) > 11 {
            menu_bitmap_to_png(mii.hbmpItem)
        } else {
            None
        };

        let primary = (mii.fState.0 & MFS_DEFAULT.0) != 0;
        let disabled = (mii.fState.0 & (MFS_DISABLED.0 | MFS_GRAYED.0)) != 0;

        cur.push(ShellMenuItem {
            label,
            shortcut,
            icon,
            verb,
            cmd_id,
            command: None,
            primary,
            disabled,
            submenu,
        });
    }

    if !cur.is_empty() {
        groups.push(cur);
    }
    groups
}

/// Strip Win32 `&` accelerator markers and split optional `\tShortcut`.
#[cfg(windows)]
fn clean_menu_label(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim_matches('\0');
    let (left, right) = match trimmed.split_once('\t') {
        Some((l, r)) => (l, Some(r.trim().to_string()).filter(|s| !s.is_empty())),
        None => (trimmed, None),
    };
    let mut out = String::with_capacity(left.len());
    let mut chars = left.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            // Also strip CJK-style "(&X)" mnemonic suffixes if present
        } else {
            out.push(c);
        }
    }
    (out.trim().to_string(), right)
}

#[cfg(windows)]
fn fnv1a_bitmap(w: i32, h: i32, pixels: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in &(w as u32).to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for &b in &(h as u32).to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for &b in pixels {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Convert a 32-bit or 24-bit Win32 menu `HBITMAP` (`hbmpItem`) into a 16x16 PNG data URL,
/// handling both premultiplied alpha (PARGB) and legacy 0-alpha GDI bitmaps, memoized by pixel hash.
#[cfg(windows)]
unsafe fn menu_bitmap_to_png(hbmp: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HDC, HGDIOBJ,
    };

    static BMP_PNG_CACHE: OnceLock<Mutex<HashMap<u64, Option<String>>>> = OnceLock::new();

    let mut bmp = BITMAP::default();
    if GetObjectW(
        HGDIOBJ(hbmp.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    ) == 0
    {
        return None;
    }
    let (w, h) = (bmp.bmWidth, bmp.bmHeight.abs());
    if w <= 0 || h <= 0 || w > 256 || h > 256 {
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: (w * h * 4) as u32,
        ..Default::default()
    };
    let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
    let hdc: HDC = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    let hash = fnv1a_bitmap(w, h, &pixels);
    let cache = BMP_PNG_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.get(&hash) {
            return hit.clone();
        }
    }

    let has_any_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
    for p in pixels.chunks_exact_mut(4) {
        let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
        if !has_any_alpha {
            // Classic non-alpha GDI bitmap: treat pure-black background corners or full RGB as opaque
            p[0] = r;
            p[1] = g;
            p[2] = b;
            p[3] = if r == 0 && g == 0 && b == 0 { 0 } else { 255 };
        } else if a > 0 && a < 255 {
            // Un-premultiply PARGB32 if premultiplied (clamp to 255)
            let af = a as u16;
            p[0] = ((r as u16 * 255 / af).min(255)) as u8;
            p[1] = ((g as u16 * 255 / af).min(255)) as u8;
            p[2] = ((b as u16 * 255 / af).min(255)) as u8;
            p[3] = a;
        } else {
            p[0] = r;
            p[1] = g;
            p[2] = b;
            p[3] = a;
        }
    }

    let encoded = crate::commands::icons::encode_png_rgba(&pixels, w as u32, h as u32, 16);
    if let Ok(mut guard) = cache.lock() {
        if guard.len() > 1024 {
            guard.clear();
        }
        guard.insert(hash, encoded.clone());
    }
    encoded
}

#[cfg(windows)]
unsafe fn invoke_icm_cmd(
    icm: &windows::Win32::UI::Shell::IContextMenu,
    cmd_id: u32,
    pt_x: i32,
    pt_y: i32,
    dir_hint: Option<&str>,
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows::core::{HSTRING, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::UI::Shell::{
        CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, SEE_MASK_ASYNCOK,
        SEE_MASK_UNICODE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow, SW_SHOWNORMAL};

    let dir_h = dir_hint.map(HSTRING::from);
    let effective_hwnd = if !hwnd.is_invalid() && hwnd != HWND::default() {
        hwnd
    } else {
        GetForegroundWindow()
    };

    if !effective_hwnd.is_invalid() {
        let _ = SetForegroundWindow(effective_hwnd);
    }

    let info = CMINVOKECOMMANDINFOEX {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_PTINVOKE | SEE_MASK_UNICODE | SEE_MASK_ASYNCOK,
        hwnd: effective_hwnd,
        lpVerb: PCSTR((cmd_id as usize) as *const u8),
        lpVerbW: PCWSTR((cmd_id as usize) as *const u16),
        lpDirectoryW: dir_h
            .as_ref()
            .map(|h| PCWSTR(h.as_ptr()))
            .unwrap_or(PCWSTR::null()),
        nShow: SW_SHOWNORMAL.0,
        ptInvoke: POINT { x: pt_x, y: pt_y },
        ..Default::default()
    };
    icm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO)
        .map_err(|e| format!("Shell action failed: {e}"))
}

#[cfg(windows)]
unsafe fn show_properties_sta(
    paths: &[String],
    page: Option<&str>,
    sessions: &mut VecDeque<ActiveMenuSession>,
) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::{SHObjectProperties, SHOP_FILEPATH};

    if paths.is_empty() {
        return Err("No path provided".into());
    }

    let norm_paths: Vec<String> = paths
        .iter()
        .map(|p| {
            let raw = p.trim();
            if raw.len() == 2 && raw.as_bytes()[1] == b':' {
                format!("{raw}\\")
            } else if !raw.starts_with("shell:") && raw.len() > 3 {
                raw.trim_end_matches('\\').to_string()
            } else {
                raw.to_string()
            }
        })
        .collect();

    if norm_paths.len() == 1 && !norm_paths[0].starts_with("shell:") {
        let p_h = HSTRING::from(norm_paths[0].as_str());
        let page_h = page.map(HSTRING::from);
        let page_ptr = page_h
            .as_ref()
            .map(|h| PCWSTR(h.as_ptr()))
            .unwrap_or(PCWSTR::null());

        let ok = SHObjectProperties(None, SHOP_FILEPATH, &p_h, page_ptr);
        if ok.as_bool() {
            return Ok(());
        }
    }

    // PIDL / `IContextMenu` fallback for multi-selection, virtual folders (`shell:...`), or drives.
    let (resp, sess) = build_items_menu(0, &norm_paths, false)?;
    if let Some(item) = resp
        .groups
        .iter()
        .flatten()
        .find(|i| i.verb.as_deref() == Some("properties"))
    {
        if let Some(cid) = item.cmd_id {
            let res = invoke_icm_cmd(
                &sess.icm,
                cid,
                0,
                0,
                None,
                windows::Win32::Foundation::HWND::default(),
            );
            push_session(sessions, sess);
            return res;
        }
    }
    Err("Could not open Properties dialog".into())
}

/// Enumerate `HKCR\Directory\Background\shell` integrations (Visual Studio, Warp,
/// VS Code, Git Bash, plus Windows Terminal packaged app) with real 16x16 icons.
/// Memoized per `(is_local, shift)` so repeat folder right-clicks take ~0ms.
#[cfg(windows)]
fn collect_registry_background_verbs(dir_path: &str, shift: bool) -> Vec<ShellMenuItem> {
    static BG_REG_CACHE: OnceLock<Mutex<HashMap<(bool, bool), Vec<ShellMenuItem>>>> =
        OnceLock::new();

    let is_local = !starts_with_unc_or_virtual(dir_path);
    let cache = BG_REG_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.get(&(is_local, shift)) {
            return hit.clone();
        }
    }

    let mut items: Vec<ShellMenuItem> = Vec::new();
    let mut seen_labels: HashSet<String> = HashSet::new();

    // Windows 11 packaged Windows Terminal (`wt.exe`) lives in WindowsApps rather than classic HKCR.
    if is_local {
        if let Some(wt_item) = detect_windows_terminal_item() {
            seen_labels.insert(wt_item.label.to_lowercase());
            items.push(wt_item);
        }
    }

    let hcr = winreg::RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT);
    let Ok(bg_shell) = hcr.open_subkey("Directory\\Background\\shell") else {
        return items;
    };

    for key_name in bg_shell.enum_keys().filter_map(|k| k.ok()) {
        let Ok(sub) = bg_shell.open_subkey(&key_name) else {
            continue;
        };
        if sub.get_value::<String, _>("LegacyDisable").is_ok()
            || sub.get_value::<String, _>("ProgrammaticAccessOnly").is_ok()
        {
            continue;
        }
        // `Extended` verbs (cmd, PowerShell, WSL) only appear on Shift+Right-Click in Explorer.
        if !shift && sub.get_raw_value("Extended").is_ok() {
            continue;
        }
        let Ok(cmd_key) = sub.open_subkey("command") else {
            continue;
        };
        let command: String = cmd_key.get_value("").unwrap_or_default();
        if command.trim().is_empty() {
            continue;
        }

        let raw_label: String = sub
            .get_value("MUIVerb")
            .ok()
            .filter(|s: &String| !s.trim().is_empty())
            .or_else(|| sub.get_value("").ok().filter(|s: &String| !s.trim().is_empty()))
            .unwrap_or_else(|| key_name.clone());
        let resolved = resolve_mui_string(&raw_label).unwrap_or(raw_label);
        let (label, shortcut) = clean_menu_label(&resolved);
        if label.is_empty() || seen_labels.contains(&label.to_lowercase()) {
            continue;
        }

        let icon_spec: String = sub.get_value("Icon").unwrap_or_default();
        let icon = if !icon_spec.trim().is_empty() {
            extract_icon_spec_png(&icon_spec)
        } else {
            first_exe_from_command(&command).and_then(|exe| extract_icon_spec_png(&exe))
        };

        seen_labels.insert(label.to_lowercase());
        items.push(ShellMenuItem {
            label,
            shortcut,
            icon,
            verb: None,
            cmd_id: None,
            command: Some(command),
            primary: false,
            disabled: false,
            submenu: Vec::new(),
        });
    }

    if let Ok(mut guard) = cache.lock() {
        guard.insert((is_local, shift), items.clone());
    }
    items
}

fn starts_with_unc_or_virtual(s: &str) -> bool {
    s.starts_with("shell:") || s.starts_with("\\\\") || s.starts_with("upnp::")
}

/// Real Windows Terminal icon (16px PNG data URL) for hand-built "Open in Terminal"
/// menu entries (sidebar etc.), memoized after the first lookup.
#[tauri::command]
pub async fn get_terminal_icon() -> Option<String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            static ICON: OnceLock<Option<String>> = OnceLock::new();
            ICON.get_or_init(|| detect_windows_terminal_item().and_then(|i| i.icon))
                .clone()
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn detect_windows_terminal_item() -> Option<ShellMenuItem> {
    let local_app = std::env::var("LOCALAPPDATA").ok()?;
    let wt_exe = PathBuf::from(&local_app)
        .join("Microsoft")
        .join("WindowsApps")
        .join("wt.exe");
    if !wt_exe.exists() {
        return None;
    }
    let wt_str = wt_exe.to_string_lossy().into_owned();
    // The `wt.exe` app-execution alias only yields a generic icon; the packaged
    // app's real Windows Terminal icon lives behind its AppsFolder AUMID.
    let icon = ["Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
        "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe!App"]
        .iter()
        .find_map(|aumid| {
            crate::commands::icons::shell_image(&format!("shell:AppsFolder\\{aumid}"), 16, true)
        })
        .or_else(|| crate::commands::icons::shell_image(&wt_str, 16, true))
        .or_else(|| extract_icon_spec_png(&wt_str));
    Some(ShellMenuItem {
        label: "Open in Terminal".into(),
        shortcut: None,
        icon,
        verb: Some("open_terminal".into()),
        cmd_id: None,
        command: Some(format!("\"{wt_str}\" -d \"%V\"")),
        primary: false,
        disabled: false,
        submenu: Vec::new(),
    })
}

#[cfg(windows)]
fn expand_env_vars(input: &str) -> String {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;

    let wide: Vec<u16> = input.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = vec![0u16; 1024];
    let n = unsafe {
        ExpandEnvironmentStringsW(PCWSTR(wide.as_ptr()), Some(&mut out))
    } as usize;
    if n > 0 && n <= out.len() {
        let _ = PWSTR::null();
        String::from_utf16_lossy(&out[..n - 1])
    } else {
        input.to_string()
    }
}

#[cfg(windows)]
fn resolve_mui_string(s: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::SHLoadIndirectString;

    let trimmed = s.trim();
    if !trimmed.starts_with('@') {
        return None;
    }
    let expanded = expand_env_vars(trimmed);
    let wide: Vec<u16> = expanded.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = [0u16; 512];
    let hr = unsafe { SHLoadIndirectString(PCWSTR(wide.as_ptr()), &mut buf, None) };
    if hr.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let out = String::from_utf16_lossy(&buf[..len]).trim().to_string();
    if out.is_empty() { None } else { Some(out) }
}

/// Extract a 16x16 PNG data URL from a registry icon spec like
/// `"C:\...\VSLauncher.exe,-105"` or `"C:\...\icon.ico"`.
#[cfg(windows)]
fn extract_icon_spec_png(spec: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

    let expanded = expand_env_vars(spec.trim().trim_matches('"'));
    let (file_part, idx) = match expanded.rsplit_once(',') {
        Some((f, i)) => {
            if let Ok(parsed) = i.trim().parse::<i32>() {
                (f.trim().trim_matches('"').to_string(), parsed)
            } else {
                (expanded.clone(), 0)
            }
        }
        None => (expanded.clone(), 0),
    };

    // Resolve bare system filenames like "shell32.dll" or "wsl.exe" via System32 if needed
    let resolved_file = if Path::new(&file_part).exists() {
        file_part.clone()
    } else if let Ok(sysroot) = std::env::var("SystemRoot") {
        let p = Path::new(&sysroot).join("System32").join(&file_part);
        if p.exists() {
            p.to_string_lossy().into_owned()
        } else {
            file_part.clone()
        }
    } else {
        file_part.clone()
    };

    let wide: Vec<u16> = resolved_file
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut small = HICON::default();
    let mut large = HICON::default();
    let extracted = unsafe {
        ExtractIconExW(
            PCWSTR(wide.as_ptr()),
            idx,
            Some(&mut large),
            Some(&mut small),
            1,
        )
    };
    if extracted > 0 {
        let chosen = if !small.is_invalid() && !small.0.is_null() {
            small
        } else {
            large
        };
        let png = if !chosen.is_invalid() && !chosen.0.is_null() {
            unsafe { crate::commands::icons::hicon_to_png(chosen, 16) }
        } else {
            None
        };
        unsafe {
            if !small.is_invalid() && !small.0.is_null() {
                let _ = DestroyIcon(small);
            }
            if !large.is_invalid() && !large.0.is_null() {
                let _ = DestroyIcon(large);
            }
        }
        if png.is_some() {
            return png;
        }
    }

    crate::commands::icons::shell_image(&resolved_file, 16, true)
}

#[cfg(windows)]
fn first_exe_from_command(cmd: &str) -> Option<String> {
    let t = cmd.trim();
    if let Some(rest) = t.strip_prefix('"') {
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    } else {
        Some(t.split_whitespace().next()?.to_string())
    }
}

#[cfg(windows)]
fn run_background_command_impl(dir_path: &str, template: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    // Avoid `"C:\"` turning `\"` into an escaped quote inside `"%V"`.
    let clean_dir = if dir_path.ends_with(":\\") {
        format!("{dir_path}\\")
    } else {
        dir_path.trim_end_matches('\\').to_string()
    };
    let expanded = expand_env_vars(template)
        .replace("%V", &clean_dir)
        .replace("%v", &clean_dir)
        .replace("%1", &clean_dir)
        .replace("%L", &clean_dir);

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    std::process::Command::new("cmd.exe")
        .raw_arg(format!("/S /C \"{expanded}\""))
        .current_dir(dir_path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch integration: {e}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn item_context_menu_extracts_real_integrations() {
        use std::time::Instant;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let target = "C:\\Ordner\\Coding\\Apps\\fast-explorer\\package.json".to_string();
            let t0 = Instant::now();
            let (resp, _sess) =
                build_items_menu(1, std::slice::from_ref(&target), false).expect("items menu");
            let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let t1 = Instant::now();
            let (_resp2, _sess2) =
                build_items_menu(2, std::slice::from_ref(&target), false).expect("items menu 2");
            let warm_ms = t1.elapsed().as_secs_f64() * 1000.0;
            let labels: Vec<String> = resp.groups.iter().flatten().map(|i| i.label.clone()).collect();
            println!(
                "Item menu cold={:.2}ms warm={:.2}ms labels={:?}",
                cold_ms, warm_ms, labels
            );
            assert!(!labels.is_empty(), "must extract shell menu items");
        }
    }

    #[test]
    fn background_menu_extracts_ide_and_terminal_integrations() {
        use std::time::Instant;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let t0 = Instant::now();
            let (resp, _sess) =
                build_background_menu(2, "C:\\Ordner\\Coding\\Apps\\fast-explorer", false)
                    .expect("bg menu");
            let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let t1 = Instant::now();
            let _ = build_background_menu(3, "C:\\Ordner\\Coding\\Apps\\fast-explorer", false)
                .expect("bg menu 2");
            let warm_ms = t1.elapsed().as_secs_f64() * 1000.0;
            println!("BG menu cold={:.2}ms warm={:.2}ms", cold_ms, warm_ms);
            for g in &resp.groups {
                for item in g {
                    println!(
                        "BG item: label={} has_icon={} cmd={:?}",
                        item.label,
                        item.icon.is_some(),
                        item.command
                    );
                }
            }
            assert!(!resp.groups.is_empty());
        }
    }
}
