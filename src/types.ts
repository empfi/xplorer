export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  size: string; // human-readable, "" for dirs
  item_type: string; // "File folder" / "PNG File" / "WinRAR ZIP archive" etc.
  modified: string; // formatted date
}

export interface Drive {
  name: string; // "C:" or "backup USB"
  path: string; // "C:\"
  label: string; // volume label: "Local Disk", "KINGSTON", "" when none
  free: string;
  total: string;
  is_network: boolean;
}

export interface DirListing {
  path: string;
  entries: FsEntry[];
  error: string | null;
}

export type ClipboardMode = "copy" | "cut";

export interface QuickLink {
  name: string;
  path: string;
}

export type SortKey = "name" | "date" | "type" | "size";
export type GroupByKey = "none" | "name" | "date" | "type" | "size";

export interface ShellMenuItem {
  label: string;
  shortcut: string | null;
  icon: string | null;
  verb: string | null;
  cmdId: number | null;
  command: string | null;
  primary: boolean;
  disabled: boolean;
  submenu: ShellMenuItem[][];
}

export interface ShellContextMenuResponse {
  sessionId: number;
  groups: ShellMenuItem[][];
}

export interface FileMetadata {
  path: string;
  name: string;
  extension: string;
  size_bytes: number;
  size_formatted: string;
  created: string;
  modified: string;
  accessed: string;
  item_type: string;
  is_dir: boolean;
  is_readonly: boolean;
  is_hidden: boolean;
}

export interface TransferProgress {
  op_type: "copy" | "move" | "delete" | "restore";
  source_dir: string;
  dest_dir: string;
  current_file: string;
  files_completed: number;
  total_files: number;
  bytes_copied: number;
  total_bytes: number;
  percent: number;
  speed_mbps: number;
  is_move: boolean;
  is_paused: boolean;
  done: boolean;
  canceled: boolean;
  error: string | null;
}

export interface PasteResult {
  is_cut: boolean;
  pairs: [string, string][];
}

export interface HistoryAction {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}
