import { useEffect, useState } from "react";
import type { FileMetadata, FsEntry } from "../types";
import { api } from "../api";
import {
  Calendar,
  Check,
  Clock,
  Code2,
  Copy,
  Eye,
  File,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize2,
  Music,
  PanelRight,
  Share2,
  Video,
  X,
} from "lucide-react";
import EntryIcon from "./EntryIcon";

interface Props {
  selectedEntries: FsEntry[];
  currentDir: string;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"]);
const TEXT_EXTS = new Set([
  "txt", "md", "json", "js", "ts", "tsx", "jsx", "rs", "py", "html", "htm", "css",
  "yaml", "yml", "xml", "csv", "log", "bat", "cmd", "ps1", "sh", "ini", "toml",
  "env", "gitignore", "sql", "c", "cpp", "h", "hpp", "java", "go", "php", "rb",
]);

export default function PreviewPane({
  selectedEntries,
  currentDir: _currentDir,
  onClose,
}: Props) {
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const [meta, setMeta] = useState<FileMetadata | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [mediaDataUrl, setMediaDataUrl] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [imgDimensions, setImgDimensions] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  const shareFile = async () => {
    if (!single) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: single.name,
          text: single.path,
        });
        return;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(single.path);
      setShared(true);
      setTimeout(() => setShared(false), 1500);
    } catch {}
  };

  const ext = single && !single.is_dir
    ? single.name.slice(single.name.lastIndexOf(".") + 1).toLowerCase()
    : "";

  useEffect(() => {
    let alive = true;
    if (!single) {
      setMeta(null);
      setTextPreview(null);
      setMediaDataUrl(null);
      setMediaLoading(false);
      setMediaError(false);
      setImgDimensions(null);
      return;
    }

    setLoading(true);
    setTextPreview(null);
    setMediaDataUrl(null);
    setImgDimensions(null);
    setMediaError(false);

    api
      .getFileMetadata(single.path)
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch(() => {
        if (alive) setMeta(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    if (!single.is_dir && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext))) {
      setMediaLoading(true);
      api
        .readFileAsDataUrl(single.path)
        .then((url) => {
          if (!alive) return;
          setMediaDataUrl(url);
          setMediaLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setMediaDataUrl(null);
          setMediaLoading(false);
          setMediaError(true);
        });
    } else {
      setMediaLoading(false);
    }

    if (!single.is_dir && TEXT_EXTS.has(ext)) {
      api
        .readTextPreview(single.path, 64 * 1024)
        .then((txt) => {
          if (alive) setTextPreview(txt);
        })
        .catch(() => {
          if (alive) setTextPreview(null);
        });
    }

    return () => {
      alive = false;
    };
  }, [single?.path, ext]);

  const copyPath = () => {
    if (!single) return;
    navigator.clipboard.writeText(single.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full w-[320px] shrink-0 flex-col border-l border-[#2e2e2e] bg-[#1a1a1a] text-[12.5px] select-text">
      {/* Top Header */}
      <div className="flex h-10 items-center justify-between border-b border-[#2e2e2e] px-3 bg-[#1e1e1e]">
        <div className="flex items-center gap-2 text-neutral-200">
          <PanelRight size={14} className="text-neutral-400" />
          <span className="text-[12.5px] font-semibold">Details</span>
        </div>

        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-[#2f2f2f] hover:text-white transition-colors"
          onClick={onClose}
          title="Close details pane"
        >
          <X size={13} />
        </button>
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {selectedEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-neutral-400">
            <PanelRight size={28} strokeWidth={1.5} className="text-neutral-500" />
            <p className="text-[12px]">Select an item to view its details and preview.</p>
          </div>
        ) : selectedEntries.length > 1 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 border-b border-[#2e2e2e] pb-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#2a2a2a] text-neutral-300">
                <FileText size={20} />
              </div>
              <div>
                <p className="font-semibold text-white">{selectedEntries.length} items selected</p>
                <p className="text-[11.5px] text-neutral-400">Multiple items</p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 text-[12px] text-neutral-300">
              <span className="text-neutral-400">Selected files & folders:</span>
              <ul className="max-h-48 overflow-y-auto space-y-1 rounded bg-[#222] p-2 text-[11px] text-neutral-300">
                {selectedEntries.map((e) => (
                  <li key={e.path} className="truncate">• {e.name}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : !single ? null : (
          <div className="flex flex-col gap-4">
            {/* Header info */}
            <div className="flex items-center gap-2.5">
              <EntryIcon entry={single} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-neutral-100" title={single.name}>
                  {single.name}
                </p>
                <p className="truncate text-[11.5px] text-neutral-400">{single.item_type}</p>
              </div>
            </div>

            {/* Share button */}
            <button
              type="button"
              onClick={shareFile}
              className="flex items-center gap-1.5 rounded bg-[#2b2b2b] hover:bg-[#353535] px-3 py-1.5 text-[12px] font-medium text-neutral-200 border border-[#383838] transition-colors w-fit"
            >
              <Share2 size={13} />
              <span>{shared ? "Path Copied!" : "Share"}</span>
            </button>

            {/* Media/Text Viewer */}
            {IMAGE_EXTS.has(ext) ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[#303030] bg-[#141414] p-2">
                {mediaLoading ? (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 text-neutral-400">
                    <Loader2 size={20} className="animate-spin text-blue-400" />
                    <span className="text-[11.5px]">Loading image preview...</span>
                  </div>
                ) : mediaDataUrl && !mediaError ? (
                  <>
                    <img
                      src={mediaDataUrl}
                      alt={single.name}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setImgDimensions(`${img.naturalWidth} × ${img.naturalHeight} px`);
                      }}
                      onError={() => setMediaError(true)}
                      className="max-h-[340px] w-auto max-w-full rounded object-contain shadow-sm"
                    />
                    {imgDimensions && (
                      <span className="text-[11px] text-neutral-400 font-mono">
                        {imgDimensions}
                      </span>
                    )}
                  </>
                ) : (
                  <div className="flex h-32 flex-col items-center justify-center gap-1.5 text-[11.5px] text-neutral-400">
                    <ImageIcon size={24} className="text-neutral-500" />
                    <span>Could not load image preview</span>
                  </div>
                )}
              </div>
            ) : VIDEO_EXTS.has(ext) ? (
              <div className="overflow-hidden rounded-lg border border-[#303030] bg-[#141414]">
                {mediaLoading ? (
                  <div className="flex h-40 items-center justify-center text-neutral-400">
                    <Loader2 size={20} className="animate-spin text-blue-400" />
                  </div>
                ) : mediaDataUrl ? (
                  <video
                    src={mediaDataUrl}
                    controls
                    className="max-h-[300px] w-full"
                  />
                ) : (
                  <div className="flex h-32 items-center justify-center text-[11.5px] text-neutral-400">
                    Could not load video preview
                  </div>
                )}
              </div>
            ) : AUDIO_EXTS.has(ext) ? (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-[#303030] bg-[#1f1f1f] p-4 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#2a2a2a] text-sky-400 shadow-md">
                  <Music size={28} />
                </div>
                {mediaLoading ? (
                  <div className="flex h-12 items-center justify-center text-neutral-400">
                    <Loader2 size={16} className="animate-spin text-blue-400" />
                  </div>
                ) : mediaDataUrl ? (
                  <audio src={mediaDataUrl} controls className="w-full" />
                ) : (
                  <div className="text-[11.5px] text-neutral-400">
                    Could not load audio preview
                  </div>
                )}
              </div>
            ) : textPreview !== null ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[11px] text-neutral-400">
                  <span className="flex items-center gap-1">
                    <Code2 size={12} /> Text Preview
                  </span>
                  <span>{textPreview.split("\n").length} lines</span>
                </div>
                <pre className="max-h-[340px] overflow-auto rounded-lg border border-[#2e2e2e] bg-[#131313] p-2.5 font-mono text-[11px] leading-relaxed text-neutral-200">
                  {textPreview || "(Empty file)"}
                </pre>
              </div>
            ) : ext === "pdf" ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-[#303030] bg-[#1f1f1f] p-8 text-center text-neutral-300">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-950/60 text-red-400 border border-red-800 shadow-md">
                  <FileText size={32} />
                </div>
                <div>
                  <p className="font-medium text-white">{single.name}</p>
                  <p className="text-[11px] text-neutral-400">{meta?.size_formatted || single.size}</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#1f1f1f] p-8 text-center text-neutral-400">
                <File size={36} strokeWidth={1.5} className="text-neutral-500" />
                <p className="text-[12px]">No live preview available.</p>
              </div>
            )}

            {/* Details Section right below the preview in the same tab */}
            <div className="border-t border-[#2e2e2e] pt-3">
              <DetailsList
                single={single}
                meta={meta}
                copyPath={copyPath}
                copied={copied}
                imgDimensions={imgDimensions}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailsList({
  single,
  meta,
  copyPath,
  copied,
  imgDimensions,
}: {
  single: FsEntry;
  meta: FileMetadata | null;
  copyPath: () => void;
  copied: boolean;
  imgDimensions: string | null;
}) {
  const dirPath = single.path.substring(0, single.path.lastIndexOf("\\")) || single.path;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-[12.5px] font-semibold text-white tracking-wide">Details</h4>

      <div className="flex flex-col gap-2.5 text-[12px]">
        {/* Type */}
        <div className="grid grid-cols-[90px_1fr] items-start gap-2">
          <span className="text-neutral-400">Type</span>
          <span className="text-neutral-200 text-right truncate">
            {meta?.item_type || single.item_type || "File"}
          </span>
        </div>

        {/* Size */}
        <div className="grid grid-cols-[90px_1fr] items-start gap-2">
          <span className="text-neutral-400">Size</span>
          <span className="text-neutral-200 text-right">
            {meta?.size_formatted || single.size || "-"}
            {meta && meta.size_bytes > 0 && (
              <span className="block text-[11px] text-neutral-400 font-mono">
                {meta.size_bytes.toLocaleString()} bytes
              </span>
            )}
          </span>
        </div>

        {/* File location */}
        <div className="grid grid-cols-[90px_1fr] items-start gap-2">
          <span className="text-neutral-400">File location</span>
          <div className="flex items-center justify-end gap-1.5 min-w-0">
            <span className="truncate text-neutral-200 text-right text-[11.5px]" title={dirPath}>
              {dirPath}
            </span>
            <button
              type="button"
              onClick={copyPath}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-[#333] hover:text-white transition-colors"
              title="Copy path"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </div>
        </div>

        {/* Date modified */}
        <div className="grid grid-cols-[90px_1fr] items-start gap-2">
          <span className="text-neutral-400">Date modified</span>
          <span className="text-neutral-200 text-right">
            {meta?.modified || single.modified || "-"}
          </span>
        </div>

        {/* Date created */}
        {meta?.created && (
          <div className="grid grid-cols-[90px_1fr] items-start gap-2">
            <span className="text-neutral-400">Date created</span>
            <span className="text-neutral-200 text-right">{meta.created}</span>
          </div>
        )}

        {/* Image Dimensions if available */}
        {imgDimensions && (
          <div className="grid grid-cols-[90px_1fr] items-start gap-2">
            <span className="text-neutral-400">Dimensions</span>
            <span className="text-neutral-200 text-right font-mono">{imgDimensions}</span>
          </div>
        )}

        {/* Attributes */}
        {meta && (
          <div className="grid grid-cols-[90px_1fr] items-center gap-2 pt-1 border-t border-[#2e2e2e]">
            <span className="text-neutral-400">Attributes</span>
            <div className="flex justify-end gap-1.5 text-[11px]">
              <span
                className={`rounded px-2 py-0.5 ${
                  meta.is_readonly
                    ? "bg-amber-950/60 text-amber-300 border border-amber-800"
                    : "bg-[#252525] text-neutral-400"
                }`}
              >
                {meta.is_readonly ? "Read-only" : "Writable"}
              </span>
              <span
                className={`rounded px-2 py-0.5 ${
                  meta.is_hidden
                    ? "bg-purple-950/60 text-purple-300 border border-purple-800"
                    : "bg-[#252525] text-neutral-400"
                }`}
              >
                {meta.is_hidden ? "Hidden" : "Visible"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
