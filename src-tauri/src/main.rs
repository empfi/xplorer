#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use std::sync::Mutex;

use commands::{clipboard, context_menu, fs_ops, shell_new, system, watcher};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let temp_icon = std::env::temp_dir().join("fast_explorer_drag_icon.png");
            if !temp_icon.exists() {
                let default_icon_bytes = include_bytes!("../icons/icon.png");
                let _ = std::fs::write(&temp_icon, default_icon_bytes);
            }
            system::spawn_drive_watcher(app.handle().clone());
            Ok(())
        })
        .manage(Mutex::new(clipboard::Clipboard::default()))
        .manage(clipboard::TransferControlState::default())
        .manage(context_menu::ContextMenuState::default())
        .manage(commands::icons::IconCache::default())
        .manage(watcher::FolderWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            fs_ops::list_dir,
            fs_ops::rename_item,
            fs_ops::delete_items,
            fs_ops::delete_items_permanently,
            fs_ops::move_item,
            fs_ops::copy_item,
            fs_ops::create_folder,
            fs_ops::create_empty_file,
            fs_ops::search_files,
            fs_ops::read_text_preview,
            fs_ops::read_file_as_data_url,
            fs_ops::get_file_metadata,
            shell_new::get_shell_new_items,
            shell_new::create_shell_new_item,
            commands::clipboard::set_clipboard,
            commands::clipboard::has_clipboard,
            commands::clipboard::paste,
            commands::clipboard::move_items_with_progress,
            commands::clipboard::cancel_transfer,
            commands::clipboard::pause_transfer,
            commands::clipboard::resume_transfer,
            commands::clipboard::start_native_drag,
            commands::clipboard::get_drag_icon_path,
            context_menu::query_shell_context_menu,
            context_menu::query_background_shell_menu,
            context_menu::invoke_shell_context_item,
            context_menu::invoke_background_command,
            context_menu::show_properties,
            context_menu::get_terminal_icon,
            context_menu::create_shortcut,
            system::get_drives,
            system::get_drive_details,
            system::list_network_hosts,
            system::get_quick_access,
            system::set_quick_access,
            system::get_downloads_path,
            system::pin_to_quick_access,
            system::unpin_from_quick_access,
            commands::recycle::list_recycle_bin,
            commands::recycle::restore_items,
            system::open_with_dialog,
            system::invoke_shell_verb,
            system::get_shell_verbs,
            system::copy_as_path,
            system::open_path,
            system::open_terminal,
            commands::icons::get_entry_icon,
            commands::icons::get_entry_icons_batch,
            watcher::watch_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
