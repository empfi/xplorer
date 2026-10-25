import { useEffect, useRef, useState } from "react";
import type { FsEntry } from "../types";
import { api } from "../api";
import { iconFor } from "./iconFor";

// Must match MEDIA_EXTS in Rust icons.rs for per-file key parity
const MEDIA_EXTS = "png jpg jpeg gif bmp webp svg ico tif tiff heic avif mp4 mkv avi mov webm wmv mp3 wav flac ogg pdf psd".split(" ");
function isMediaExt(ext: string): boolean {
  return MEDIA_EXTS.includes(ext.toLowerCase());
}
// Must match needs_path_lookup in Rust icons.rs: shortcut icons resolve from
// the real path, so they need per-file cache keys too.
const SHORTCUT_EXTS = ["lnk", "url", "appref-ms"];

// Known Windows special folders that carry custom desktop.ini / shell icons
// (Desktop, Downloads, Documents, Pictures, Music, Videos, etc.) so they
// always resolve their distinct Microsoft Explorer icon even in FileView.
const SPECIAL_DIR_NAMES = new Set([
  "desktop",
  "downloads",
  "documents",
  "my documents",
  "pictures",
  "my pictures",
  "music",
  "my music",
  "videos",
  "my videos",
  "favorites",
  "favourites",
  "links",
  "contacts",
  "searches",
  "saved games",
  "onedrive",
  "3d objects",
  "recent",
  "home",
]);

function hasUniqueDirIcon(entry: FsEntry, perPath: boolean): boolean {
  if (!entry.is_dir) return false;
  if (perPath) return true;
  const p = entry.path;
  if (
    p.startsWith("shell:") ||
    p.startsWith("::") ||
    p.startsWith("\\\\") ||
    p.startsWith("upnp::") ||
    /^[A-Za-z]:\\?$/.test(p) ||
    /^[A-Za-z]:\\Users\\[^\\]+\\?$/i.test(p)
  ) {
    return true;
  }
  const leaf = (p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? entry.name).toLowerCase();
  const n = entry.name.toLowerCase();
  return (
    SPECIAL_DIR_NAMES.has(n) ||
    SPECIAL_DIR_NAMES.has(leaf) ||
    n.startsWith("my drive") ||
    n.startsWith("onedrive") ||
    n.startsWith("icloud") ||
    n.startsWith("dropbox")
  );
}

interface IconRequest {
  key: string;
  path: string;
  isDir: boolean;
  ext: string;
  size: number;
  preview: boolean;
  unique?: boolean;
}

// Client-side resolved URLs, shared across all views.
const cache = new Map<string, string>();
const resolveListeners = new Map<string, Set<(u: string | null) => void>>();

// Queue flushed once per microtask-frame: N EntryIcons mounting together
// become ONE IPC call instead of N round-trips.
let queue = new Map<string, IconRequest>();
let flushScheduled = false;
// One huge IPC with hundreds of base64 thumbnails blocks the UI thread
// (serialization + decode). Small chunks spread over frames keep it smooth.
const FLUSH_CHUNK = 24;

function deliver(batch: Map<string, IconRequest>, results: { key: string; url: string | null }[] | null) {
  if (results) {
    for (const r of results) {
      if (r.url) cache.set(r.key, r.url);
    }
  }
  for (const key of batch.keys()) {
    const url = cache.get(key) ?? null;
    const subs = resolveListeners.get(key);
    if (subs) {
      resolveListeners.delete(key);
      for (const fn of subs) fn(url);
    }
  }
}

async function flush() {
  flushScheduled = false;
  // Take one chunk per call; re-schedule while the queue drains.
  const batch = new Map<string, IconRequest>();
  for (const [k, v] of queue) {
    batch.set(k, v);
    queue.delete(k);
    if (batch.size >= FLUSH_CHUNK) break;
  }
  if (!batch.size) return;
  if (queue.size && !flushScheduled) {
    flushScheduled = true;
    setTimeout(flush, 0);
  }
  try {
    const results = await api.getEntryIconsBatch([...batch.values()]);
    deliver(batch, results);
  } catch {
    deliver(batch, null);
  }
}

function subscribe(key: string, req: IconRequest, fn: (u: string | null) => void): () => void {
  if (cache.has(key)) {
    fn(cache.get(key)!);
    return () => {};
  }
  let subs = resolveListeners.get(key);
  if (!subs) {
    subs = new Set();
    resolveListeners.set(key, subs);
    // First subscriber for this key -> enqueue one lookup.
    queue.set(key, req);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
  };
}

export default function EntryIcon({
  entry,
  size,
  className,
  /** Opt out of the shared folder slot (drives/special folders need their own icon). */
  perPath = false,
}: {
  entry: FsEntry;
  size: number;
  className?: string;
  perPath?: boolean;
}) {
  const isUpnp = entry.path.startsWith("upnp::");
  const isUniqueDir = hasUniqueDirIcon(entry, perPath);
  const ext = isUpnp
    ? entry.item_type
    : entry.is_dir
      ? ""
      : entry.name.split(".").pop() ?? "";
  const extL = ext.toLowerCase().replace(/^\./, "");
  const preview = size >= 48; // grid tiles want real content; rows don't
  // Keep this EXACTLY in sync with key_for() in Rust icons.rs, or results
  // resolve under keys the frontend never reads.
  const perFile = entry.is_dir ? false : isMediaExt(extL) || SHORTCUT_EXTS.includes(extL);
  // Must mirror key_for() in Rust icons.rs: dirs share one slot unless unique.
  const dirKey = (s: number) =>
    isUpnp
      ? `d:${s}:${extL}:${entry.path}`
      : isUniqueDir
        ? `d:${s}:${entry.path}`
        : `d:${s}:folder`;
  const key =
    entry.is_dir
      ? dirKey(size)
      : perFile
        ? `t:${size}:${preview ? "true" : "false"}:${entry.path}`
        : `e:${size}:${extL}`;
  const req = useRef<IconRequest>({
    key,
    path: entry.path,
    isDir: entry.is_dir,
    ext,
    size,
    preview,
    unique: isUniqueDir,
  });
  req.current = { key, path: entry.path, isDir: entry.is_dir, ext: extL, size, preview, unique: isUniqueDir };

  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    if (cache.has(key)) {
      setUrl(cache.get(key)!);
      return;
    }
    // seamless list → grid: show the smaller cached icon scaled up while
    // the higher-res one resolves, instead of dropping to a vector fallback.
    // Probe only a handful of direct candidates instead of scanning every
    // cached key (O(1)-ish instead of O(cache size) per mount).
    let stopgap: string | null = null;
    if (entry.is_dir) {
      for (const s of [16, 20, 24, 32, 48, 52, 64, 128]) {
        const k = dirKey(s);
        if (cache.has(k)) { stopgap = cache.get(k)!; break; }
      }
    } else if (perFile) {
      for (const s of [16, 20, 24, 32, 48, 52, 64, 128]) {
        const k = `t:${s}:false:${entry.path}`;
        if (cache.has(k)) { stopgap = cache.get(k)!; break; }
        const k2 = `t:${s}:true:${entry.path}`;
        if (cache.has(k2)) { stopgap = cache.get(k2)!; break; }
      }
    } else {
      for (const s of [16, 20, 24, 32, 48, 52, 64, 128]) {
        const k = `e:${s}:${extL}`;
        if (cache.has(k)) { stopgap = cache.get(k)!; break; }
      }
    }
    setUrl(stopgap);
    const unsub = subscribe(key, req.current, (u) => {
      setUrl(u);
    });
    return unsub;
  }, [key, perFile, extL, entry.path, entry.is_dir]);

  if (!url) {
    const Fallback = iconFor(entry);
    return <Fallback size={size} className={className} />;
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      draggable={false}
      alt=""
      className={className}
      style={{ objectFit: "contain", maxWidth: size, maxHeight: size, flexShrink: 0 }}
    />
  );
}
