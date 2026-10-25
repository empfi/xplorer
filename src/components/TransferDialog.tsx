import { useEffect, useRef, useState } from "react";
import type { TransferProgress } from "../types";
import { api, onTransferProgress } from "../api";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Minus,
  Move,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { getCurrentWindow, currentMonitor, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 bytes";
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${Math.round(bytes)} bytes`;
}

function formatRemainingTime(remainingBytes: number, speedMbps: number): string {
  if (remainingBytes <= 0) return "A few seconds remaining";
  if (speedMbps <= 0.05) return "Estimating time remaining…";
  const speedBytesPerSec = speedMbps * 1024 * 1024;
  const secs = Math.round(remainingBytes / speedBytesPerSec);
  if (secs <= 2) return "Less than 5 seconds remaining";
  if (secs < 60) return `About ${secs} seconds remaining`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `About ${mins} minute${mins === 1 ? "" : "s"} remaining`;
  const hours = (secs / 3600).toFixed(1);
  return `About ${hours} hours remaining`;
}

function shortFolderName(path: string): string {
  if (!path) return "";
  const norm = path.replace(/[\\/]+$/, "");
  const seg = norm.split(/[\\/]/).pop();
  return seg || norm;
}

interface Props {
  standalone?: boolean;
}

export default function TransferDialog({ standalone = false }: Props) {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);

  const lastFileRef = useRef<string>("");
  const closeTimerRef = useRef<number | null>(null);

  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ isDragging: boolean; startX: number; startY: number; origX: number; origY: number }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  const appWindow = useRef<any>(null);
  const hasPositionedRef = useRef(false);

  useEffect(() => {
    try {
      appWindow.current = getCurrentWindow();
    } catch {}
  }, []);

  const positionAtBottomRight = async () => {
    if (!standalone || !appWindow.current || hasPositionedRef.current) return;
    try {
      const monitor = await currentMonitor();
      if (monitor) {
        const scale = monitor.scaleFactor || 1;
        const screenW = monitor.size.width / scale;
        const screenH = monitor.size.height / scale;
        const posX = Math.round(monitor.position.x / scale + screenW - 460);
        const posY = Math.round(monitor.position.y / scale + screenH - 220);
        await appWindow.current.setPosition(new LogicalPosition(Math.max(20, posX), Math.max(20, posY)));
        hasPositionedRef.current = true;
      }
    } catch {}
  };

  const getTargetHeight = (details: boolean, opType?: string) => {
    if (!details) return 155;
    if (opType === "delete" || opType === "restore") return 240;
    return 320;
  };

  const updateWindowHeight = (details: boolean, opType?: string) => {
    if (!standalone || !appWindow.current) return;
    try {
      const targetHeight = getTargetHeight(details, opType);
      appWindow.current.setSize(new LogicalSize(440, targetHeight)).catch(() => {});
    } catch {}
  };

  useEffect(() => {
    return onTransferProgress((p) => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      if (p.current_file && p.current_file !== "Done" && !p.current_file.startsWith("Preparing")) {
        lastFileRef.current = p.current_file;
      }

      setProgress(p);
      setVisible(true);
      setIsPaused(p.is_paused);

      if (p.canceled) {
        setIsCanceling(false);
      }

      setSpeedHistory((prev) => [...prev.slice(-34), Math.max(0, p.speed_mbps || 0)]);

      if (standalone && appWindow.current) {
        positionAtBottomRight();
        updateWindowHeight(showDetails, p.op_type);
        appWindow.current.show().catch(() => {});
      }

      if (p.done) {
        setIsCanceling(false);
        closeTimerRef.current = window.setTimeout(() => {
          if (standalone && appWindow.current) {
            appWindow.current.hide().catch(() => {});
          } else {
            setVisible(false);
          }
          setSpeedHistory([]);
          setPosition(null);
          hasPositionedRef.current = false;
        }, 2200);
      }
    });
  }, [standalone, showDetails]);

  const onMouseDownHeader = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const defaultX = Math.round(window.innerWidth / 2 - 220);
    const defaultY = Math.round(window.innerHeight / 2 - 80);
    const currentX = position ? position.x : defaultX;
    const currentY = position ? position.y : defaultY;

    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: currentX,
      origY: currentY,
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current.isDragging) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const nx = Math.max(10, Math.min(window.innerWidth - 300, dragRef.current.origX + dx));
      const ny = Math.max(10, Math.min(window.innerHeight - 150, dragRef.current.origY + dy));
      setPosition({ x: nx, y: ny });
    };

    const onMouseUp = () => {
      dragRef.current.isDragging = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleMouseDownHeader = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (standalone && appWindow.current) {
      appWindow.current.startDragging().catch(() => {});
      return;
    }
    onMouseDownHeader(e);
  };

  const handleMinimize = () => {
    if (standalone && appWindow.current) {
      appWindow.current.minimize().catch(() => {});
    }
  };

  const handleCancel = () => {
    setIsCanceling(true);
    api.cancelTransfer().catch(() => {});
  };

  const handleClose = () => {
    const isComplete = progress?.done && !progress?.error && !progress?.canceled;
    if (!isComplete) handleCancel();
    if (standalone && appWindow.current) {
      appWindow.current.hide().catch(() => {});
    } else {
      setVisible(false);
    }
  };

  const toggleDetails = () => {
    const next = !showDetails;
    setShowDetails(next);
    updateWindowHeight(next, progress?.op_type);
  };

  if (!standalone && (!visible || !progress)) return null;

  if (standalone && !progress) {
    return (
      <div className="h-full w-full select-none overflow-hidden bg-[#202020] text-neutral-200 border border-[#353535] flex flex-col justify-between font-sans">
        <div
          data-tauri-drag-region
          onMouseDown={handleMouseDownHeader}
          className="flex h-8 cursor-move items-center justify-between border-b border-[#2b2b2b] bg-[#1a1a1a] pl-3 pr-0 text-[12px]"
        >
          <div className="flex items-center gap-2 truncate text-neutral-300">
            <Copy size={13} className="shrink-0 text-emerald-400" />
            <span className="truncate">File Operation</span>
          </div>
          <div className="flex items-stretch h-full">
            <button
              type="button"
              className="flex w-11 items-center justify-center text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
              onClick={handleMinimize}
              title="Minimize"
            >
              <Minus size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="flex w-11 items-center justify-center text-neutral-400 hover:bg-[#c42b1c] hover:text-white transition-colors"
              onClick={handleClose}
              title="Close"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="px-5 py-4 flex flex-col gap-2 flex-1 justify-center">
          <div className="text-[20px] font-semibold text-white tracking-tight leading-none">
            Preparing…
          </div>
          <p className="text-[12px] text-neutral-400">Discovering items and calculating size…</p>
          <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#323232]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-[#107c41]" />
          </div>
        </div>
      </div>
    );
  }

  if (!progress) return null;

  const isMove = progress.op_type === "move" || progress.is_move;
  const isDelete = progress.op_type === "delete";
  const isRestore = progress.op_type === "restore";
  const isComplete = progress.done && !progress.error && !progress.canceled;
  const remainingBytes = Math.max(0, progress.total_bytes - progress.bytes_copied);
  const remainingFiles = Math.max(0, progress.total_files - progress.files_completed);

  const titlePrefix = isComplete
    ? isDelete
      ? "Delete complete"
      : isRestore
      ? "Restore complete"
      : isMove
      ? "Move complete"
      : "Copy complete"
    : isDelete
    ? `Deleting ${progress.total_files} item(s)`
    : isRestore
    ? `Restoring ${progress.total_files} item(s)`
    : isMove
    ? `Moving ${progress.total_files} item(s)`
    : `Copying ${progress.total_files} item(s)`;

  const srcFolder = shortFolderName(progress.source_dir) || "Recycle Bin";
  const dstFolder = shortFolderName(progress.dest_dir) || "Original location";
  const windowTitle = isDelete
    ? `${titlePrefix} from ${srcFolder}`
    : isRestore
    ? `${titlePrefix} to ${dstFolder}`
    : `${titlePrefix} from ${srcFolder} to ${dstFolder}`;

  const remainingTimeText = isComplete
    ? `Completed • ${progress.files_completed} of ${progress.total_files} items`
    : isPaused
    ? "Paused"
    : isCanceling
    ? "Canceling…"
    : isDelete
    ? `Deleting from ${srcFolder} • ${progress.files_completed} of ${progress.total_files} items`
    : isRestore
    ? `Restoring to ${dstFolder} • ${progress.files_completed} of ${progress.total_files} items`
    : formatRemainingTime(remainingBytes, progress.speed_mbps);

  const togglePause = () => {
    if (isPaused) {
      api.resumeTransfer().catch(() => {});
      setIsPaused(false);
    } else {
      api.pauseTransfer().catch(() => {});
      setIsPaused(true);
    }
  };

  const maxSpeed = Math.max(10, ...speedHistory, progress.speed_mbps || 0);
  const graphPoints = speedHistory.map((s, idx) => {
    const x = (idx / Math.max(1, speedHistory.length - 1)) * 392;
    const y = 52 - (s / maxSpeed) * 44;
    return `${x},${y}`;
  });
  const pathData = graphPoints.length > 1 ? `M 0,52 L ${graphPoints.join(" ")}` : "M 0,52";
  const areaData =
    graphPoints.length > 1
      ? `M 0,52 L ${graphPoints.join(" ")} L 392,52 Z`
      : "M 0,52 L 392,52 Z";

  const winLeft = position ? `${position.x}px` : "calc(50% - 220px)";
  const winTop = position ? `${position.y}px` : "calc(50% - 80px)";
  const displayPercent = isComplete ? 100 : Math.round(progress.percent || 0);

  const currentFileName =
    progress.current_file ||
    lastFileRef.current ||
    (isComplete ? "Completed" : "Finalizing…");

  const containerClass = standalone
    ? "h-full w-full select-none overflow-hidden bg-[#202020] text-neutral-200 border border-[#353535] flex flex-col justify-between font-sans"
    : "fixed z-50 select-none overflow-hidden rounded-xl border border-[#353535] bg-[#202020] text-neutral-200 shadow-[0_22px_60px_rgba(0,0,0,0.85)] ring-1 ring-white/10 font-sans";

  const containerStyle = standalone
    ? {}
    : {
        left: winLeft,
        top: winTop,
        width: "440px",
        backdropFilter: "blur(24px)",
      };

  return (
    <div className={containerClass} style={containerStyle}>
      {/* Title Bar (Native Windows 11 style) */}
      <div
        data-tauri-drag-region
        className="flex h-8 cursor-move items-center justify-between border-b border-[#2b2b2b] bg-[#1a1a1a] pl-3.5 pr-0 text-[12px]"
        onMouseDown={handleMouseDownHeader}
      >
        <div className="flex items-center gap-2 truncate pr-2 text-neutral-300">
          {isComplete ? (
            <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
          ) : isDelete ? (
            <Trash2 size={13} className="shrink-0 text-red-400" />
          ) : isRestore ? (
            <RotateCcw size={13} className="shrink-0 text-emerald-400" />
          ) : isMove ? (
            <Move size={13} className="shrink-0 text-sky-400" />
          ) : (
            <Copy size={13} className="shrink-0 text-emerald-400" />
          )}
          <span className="truncate font-normal" title={windowTitle}>
            {windowTitle}
          </span>
        </div>

        <div className="flex items-stretch h-full">
          <button
            type="button"
            className="flex w-11 items-center justify-center text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
            onClick={handleMinimize}
            title="Minimize"
          >
            <Minus size={11} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="flex w-11 items-center justify-center text-neutral-400 hover:bg-[#c42b1c] hover:text-white transition-colors"
            onClick={handleClose}
            title={isComplete ? "Close" : "Cancel"}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Main Body */}
      <div className="px-5 pt-3.5 pb-3 flex-1 flex flex-col justify-between">
        {progress.error ? (
          <div className="rounded bg-red-950/60 p-2.5 text-[11.5px] text-red-300 border border-red-800/80">
            <p className="font-semibold">Transfer encountered an error:</p>
            <p className="mt-1 whitespace-pre-wrap">{progress.error}</p>
          </div>
        ) : progress.canceled ? (
          <div className="text-[12px] text-amber-300">
            Operation was canceled. Partial files were safely cleaned up.
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Status Header: Big percentage and single clear subtitle */}
            <div className="text-[20px] font-semibold text-white tracking-tight leading-none">
              {displayPercent}% complete
            </div>
            <div className="mt-1 text-[12px] text-neutral-400 truncate">
              {remainingTimeText}
            </div>

            {/* Signature Windows 11 Green Progress Bar */}
            <div className="relative mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#323232]">
              <div
                className={`h-full rounded-full transition-all duration-150 ease-out ${
                  isPaused ? "bg-amber-500" : "bg-[#107c41]"
                }`}
                style={{ width: `${Math.max(2, Math.min(100, displayPercent))}%` }}
              />
            </div>

            {/* Real Windows Explorer Speed Velocity Curve Graph (Copy / Move only) */}
            {showDetails && !isDelete && !isRestore && (
              <div className="relative mt-2.5 h-[56px] w-full rounded border border-[#2b2b2b] bg-[#141414] overflow-hidden">
                <svg className="h-full w-full" viewBox="0 0 392 56" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="speedGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#107c41" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="#107c41" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal gridlines */}
                  <line x1="0" y1="14" x2="392" y2="14" stroke="#222222" strokeDasharray="3,3" />
                  <line x1="0" y1="34" x2="392" y2="34" stroke="#222222" strokeDasharray="3,3" />

                  {/* Shaded speed curve area */}
                  <path d={areaData} fill="url(#speedGrad)" />
                  {/* Glowing speed curve stroke */}
                  <path
                    d={pathData}
                    fill="none"
                    stroke="#16a34a"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>

                {/* Speed Scale Labels */}
                <div className="pointer-events-none absolute right-2 top-1 flex flex-col items-end text-[9px] font-mono text-neutral-400">
                  <span>{maxSpeed.toFixed(0)} MB/s</span>
                  <span className="mt-4">0 MB/s</span>
                </div>
              </div>
            )}

            {/* Windows 11 Fluent Clean Metadata List (No ugly boxes, perfectly fitted) */}
            {showDetails && (
              <div className="mt-2.5 space-y-1 text-[11.5px]">
                <div className="flex items-baseline">
                  <span className="w-[100px] shrink-0 text-neutral-400">Name:</span>
                  <span
                    className="truncate text-neutral-200 font-normal"
                    title={currentFileName}
                  >
                    {currentFileName}
                  </span>
                </div>
                <div className="flex items-baseline">
                  <span className="w-[100px] shrink-0 text-neutral-400">From:</span>
                  <span className="truncate text-neutral-200 font-normal" title={progress.source_dir}>
                    {progress.source_dir || "Recycle Bin"}
                  </span>
                </div>
                {!isDelete && (
                  <div className="flex items-baseline">
                    <span className="w-[100px] shrink-0 text-neutral-400">To:</span>
                    <span className="truncate text-neutral-200 font-normal" title={progress.dest_dir}>
                      {progress.dest_dir || "Original Location"}
                    </span>
                  </div>
                )}
                <div className="flex items-baseline">
                  <span className="w-[100px] shrink-0 text-neutral-400">Items remaining:</span>
                  <span className="text-neutral-200 font-normal">
                    {isComplete
                      ? "0"
                      : `${remainingFiles} ${remainingBytes > 0 ? `(${formatBytes(remainingBytes)})` : ""}`}
                  </span>
                </div>
                {!isDelete && !isRestore && (
                  <div className="flex items-baseline">
                    <span className="w-[100px] shrink-0 text-neutral-400">Speed:</span>
                    <span className="font-medium text-emerald-400">
                      {progress.speed_mbps > 0.05
                        ? `${progress.speed_mbps.toFixed(1)} MB/s`
                        : isComplete ? "Completed" : "< 1 MB/s"}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Bottom Controls Bar (Sleek and aligned) */}
        <div className="pt-2 mt-auto flex items-center justify-between border-t border-[#2b2b2b]">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[11.5px] text-[#60cdff] hover:text-[#78d5ff] hover:underline cursor-pointer transition-colors"
            onClick={toggleDetails}
          >
            {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{showDetails ? "Fewer details" : "More details"}</span>
          </button>

          <div className="flex items-center gap-2">
            {!isDelete && !isRestore && !isComplete && (
              <button
                type="button"
                className="h-[26px] px-3 rounded-md bg-[#2d2d2d] hover:bg-[#383838] active:bg-[#252525] border border-white/10 text-[11.5px] font-medium text-neutral-200 flex items-center gap-1.5 transition-colors shadow-sm"
                onClick={togglePause}
                title={isPaused ? "Resume transfer" : "Pause transfer"}
              >
                {isPaused ? <Play size={10} /> : <Pause size={10} />}
                <span>{isPaused ? "Resume" : "Pause"}</span>
              </button>
            )}

            <button
              type="button"
              className="min-w-[72px] h-[26px] px-3 rounded-md bg-[#2d2d2d] hover:bg-[#383838] active:bg-[#252525] border border-white/10 text-[11.5px] font-medium text-neutral-200 flex items-center justify-center transition-colors shadow-sm"
              onClick={handleClose}
              disabled={isCanceling}
              title={isComplete ? "Close dialog" : "Cancel operation"}
            >
              <span>{isComplete ? "Close" : isCanceling ? "Canceling…" : "Cancel"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
