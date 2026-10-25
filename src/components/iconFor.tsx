import type { FsEntry } from "../types";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines, Archive, File, FileCode2, FileImage, FileText, FileVideo,
  Folder, Puzzle, Settings,
} from "lucide-react";

/** Vector fallback icon while the shell icon/thumbnail loads (or if missing). */
export function iconFor(e: FsEntry): LucideIcon {
  if (e.is_dir) return Folder;
  const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "bmp":
    case "webp":
    case "svg":
    case "ico":
      return FileImage;
    case "txt":
    case "md":
    case "pdf":
      return FileText;
    case "mp4":
    case "mkv":
    case "avi":
    case "mov":
      return FileVideo;
    case "mp3":
    case "wav":
    case "flac":
      return AudioLines;
    case "zip":
    case "7z":
    case "rar":
      return Archive;
    case "exe":
    case "msi":
    case "bat":
    case "cmd":
      return Settings;
    case "rs":
    case "ts":
    case "js":
    case "tsx":
    case "json":
    case "toml":
      return FileCode2;
    case "dll":
      return Puzzle;
    default:
      return File;
  }
}
