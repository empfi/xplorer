import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ClipboardMode,
  DirListing,
  Drive,
  FileMetadata,
  FsEntry,
  PasteResult,
  QuickLink,
  ShellContextMenuResponse,
  TransferProgress,
} from "./types";

/**
 * Subscribe to live drive hot-plug events (USB plugged/unplugged, network drive
 * mapped/removed). The callback receives the current drive letters ("C:", "D:").
 * Returns an unsubscribe function; a no-op outside the Tauri runtime.
 */
export function onDrivesChanged(cb: (letters: string[]) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<string[]>("drives-changed", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to live Quick Access pins updates (pinned / unpinned / reordered).
 */
export function onQuickAccessChanged(cb: (links: QuickLink[]) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<QuickLink[]>("quick-access-changed", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to live folder change events (files created/deleted/renamed/modified in active directory).
 */
export function onFolderChanged(cb: (path: string) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<string>("folder-changed", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to external path opening (e.g. from second instance or default file manager launch).
 */
export function onExternalOpenPath(cb: (path: string) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<string>("open-path-external", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to Win+E global hotkey interception.
 */
export function onWinEPressed(cb: () => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<void>("win-e-pressed", () => cb())
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export interface FileDialogEventData {
  hwnd: number;
  active_folder: string;
  tabs: string[];
}

/**
 * Subscribe to Windows Open/Save file dialog detection events.
 */
export function onFileDialogDetected(cb: (data: FileDialogEventData) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<FileDialogEventData>("file-dialog-detected", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to file dialog closed events.
 */
export function onFileDialogClosed(cb: () => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<void>("file-dialog-closed", () => cb())
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Subscribe to streaming copy/move progress updates (speed, percentage, remaining bytes).
 */
export function onTransferProgress(cb: (progress: TransferProgress) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<TransferProgress>("transfer-progress", (ev) => cb(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export const api = {
  watchFolder: (path: string) => invoke<void>("watch_folder", { path }),
  searchFiles: (dirPath: string, query: string, maxResults?: number) =>
    invoke<FsEntry[]>("search_files", { dirPath, query, maxResults: maxResults ?? null }),
  readTextPreview: (path: string, maxBytes?: number) =>
    invoke<string>("read_text_preview", { path, maxBytes: maxBytes ?? null }),
  readFileAsDataUrl: (path: string, maxBytes?: number) =>
    invoke<string>("read_file_as_data_url", { path, maxBytes: maxBytes ?? null }),
  getFileMetadata: (path: string) =>
    invoke<FileMetadata>("get_file_metadata", { path }),
  getDownloadsPath: () => invoke<string>("get_downloads_path"),
  getTerminalIcon: () => invoke<string | null>("get_terminal_icon"),
  listDir: (path: string) => invoke<DirListing>("list_dir", { path }),
  getDrives: () => invoke<Drive[]>("get_drives"),
  getDriveDetails: (path: string) =>
    invoke<{ path: string; label: string; free: string; total: string }>("get_drive_details", { path }),
  getNetworkHosts: () => invoke<FsEntry[]>("list_network_hosts"),
  getQuickAccess: () => invoke<QuickLink[]>("get_quick_access"),
  setQuickAccess: (links: QuickLink[]) => invoke<void>("set_quick_access", { links }),
  pinToQuickAccess: (name: string, path: string) =>
    invoke<QuickLink[]>("pin_to_quick_access", { name, path }),
  unpinFromQuickAccess: (path: string) =>
    invoke<QuickLink[]>("unpin_from_quick_access", { path }),
  getShellVerbs: (path: string) =>
    invoke<{ verb: string; label: string }[]>("get_shell_verbs", { path }),
  invokeShellVerb: (path: string, verb: string) =>
    invoke<void>("invoke_shell_verb", { path, verb }),
  openWithDialog: (path: string) => invoke<void>("open_with_dialog", { path }),
  copyAsPath: (paths: string[]) => invoke<void>("copy_as_path", { paths }),
  openPath: (path: string) => invoke<string>("open_path", { path }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
  setClipboard: (paths: string[], mode: ClipboardMode) =>
    invoke<void>("set_clipboard", { paths, mode }),
  hasClipboard: () => invoke<boolean>("has_clipboard"),
  paste: (destDir: string) => invoke<PasteResult>("paste", { destDir }),
  moveItemsWithProgress: (paths: string[], destDir: string) =>
    invoke<PasteResult>("move_items_with_progress", { paths, destDir }),
  cancelTransfer: () => invoke<void>("cancel_transfer"),
  pauseTransfer: () => invoke<void>("pause_transfer"),
  resumeTransfer: () => invoke<void>("resume_transfer"),
  startNativeDrag: (paths: string[]) => invoke<void>("start_native_drag", { paths }),
  getDragIconPath: () => invoke<string>("get_drag_icon_path"),
  deleteItems: (paths: string[]) => invoke<void>("delete_items", { paths }),
  deleteItemsPermanently: (paths: string[]) =>
    invoke<void>("delete_items_permanently", { paths }),
  restoreItems: (paths: string[]) => invoke<void>("restore_items", { paths }),
  moveItem: (from: string, to: string) => invoke<void>("move_item", { from, to }),
  copyItem: (from: string, to: string) => invoke<void>("copy_item", { from, to }),
  renameItem: (from: string, to: string) => invoke<void>("rename_item", { from, to }),
  createFolder: (parentDir: string, name: string) => invoke<string>("create_folder", { parentDir, name }),
  createEmptyFile: (parentDir: string, name: string) => invoke<string>("create_empty_file", { parentDir, name }),
  getShellNewItems: () =>
    invoke<{ label: string; ext: string; kind: { type: "empty" | "template" | "command" } }[]>(
      "get_shell_new_items",
    ),
  createShellNewItem: (parentDir: string, ext: string, label: string) =>
    invoke<string>("create_shell_new_item", { parentDir, ext, label }),
  getEntryIconsBatch: (requests: { key: string; path: string; isDir: boolean; ext: string; size: number; preview: boolean; unique?: boolean }[]) =>
    invoke<{ key: string; url: string | null }[]>("get_entry_icons_batch", { requests }),
  queryShellContextMenu: (paths: string[], shift: boolean) =>
    invoke<ShellContextMenuResponse>("query_shell_context_menu", { paths, shift }),
  queryBackgroundShellMenu: (dirPath: string, shift: boolean) =>
    invoke<ShellContextMenuResponse>("query_background_shell_menu", { dirPath, shift }),
  invokeShellContextItem: (
    sessionId: number,
    cmdId: number,
    ptX: number,
    ptY: number,
    dirHint?: string,
  ) =>
    invoke<void>("invoke_shell_context_item", {
      sessionId,
      cmdId,
      ptX: Math.round(ptX),
      ptY: Math.round(ptY),
      dirHint: dirHint ?? null,
    }),
  invokeBackgroundCommand: (dirPath: string, command: string) =>
    invoke<void>("invoke_background_command", { dirPath, command }),
  showProperties: (paths: string[], page?: string) =>
    invoke<void>("show_properties", { paths, page: page ?? null }),
  createShortcut: (paths: string[], destDir?: string) =>
    invoke<string[]>("create_shortcut", { paths, destDir: destDir ?? null }),
  getInitialLaunchPath: () => invoke<string | null>("get_initial_launch_path"),
  isDefaultFileManager: () => invoke<boolean>("is_default_file_manager"),
  setAsDefaultFileManager: () => invoke<void>("set_as_default_file_manager"),
  unsetAsDefaultFileManager: () => invoke<void>("unset_as_default_file_manager"),
  isWinEInterceptionEnabled: () => invoke<boolean>("is_win_e_interception_enabled"),
  setWinEInterceptionEnabled: (enabled: boolean) =>
    invoke<void>("set_win_e_interception_enabled", { enabled }),
  syncActiveFolder: (activePath: string, tabs: string[]) =>
    invoke<void>("sync_active_folder", { activePath, tabs }),
  quickSwitchFileDialog: () => invoke<boolean>("quick_switch_file_dialog"),
  jumpDialogToPath: (targetPath: string) =>
    invoke<boolean>("jump_dialog_to_path", { targetPath }),
  isDialogCompanionEnabled: () => invoke<boolean>("is_dialog_companion_enabled"),
  setDialogCompanionEnabled: (enabled: boolean) =>
    invoke<void>("set_dialog_companion_enabled", { enabled }),
  isAutoJumpEnabled: () => invoke<boolean>("is_auto_jump_enabled"),
  setAutoJumpEnabled: (enabled: boolean) =>
    invoke<void>("set_auto_jump_enabled", { enabled }),
};
