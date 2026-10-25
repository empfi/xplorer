import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { FsEntry, GroupByKey, SortKey } from "../types";
import { api } from "../api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import EntryIcon from "./EntryIcon";

let cachedDragIconPath = "";
api.getDragIconPath().then((p) => {
  cachedDragIconPath = p;
}).catch(() => {});

interface Props {
  entries: FsEntry[];
  error: string | null;
  loading: boolean;
  view: "list" | "grid";
  zoom?: number;
  onZoom?: (delta: number) => void;
  selected: Set<string>;
  cutPaths?: Set<string>;
  groupBy?: GroupByKey;
  currentPath?: string;
  searchQuery?: string;
  isSearching?: boolean;
  onSelect: (path: string, additive: boolean) => void;
  onSelectRange: (paths: string[], additive: boolean) => void;
  onShiftSelect?: (path: string, additive: boolean) => void;
  sortKey?: SortKey;
  sortDir?: 1 | -1;
  onSort?: (key: SortKey) => void;
  onOpen: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry | null) => void;
  onWarmContextMenu?: (entry: FsEntry, shiftKey: boolean) => void;
  renamingPath?: string | null;
  onRenameConfirm: (newName: string) => void;
  onRenameCancel: () => void;
  onDropInto?: (targetDirPath: string, items: string[]) => void;
}

interface RowCtx {
  zoom: number;
  colTemplate: string;
  dragOverPath: string | null;
  selected: Set<string>;
  cutPaths: Set<string>;
  currentPath?: string;
  onSelect: (path: string, additive: boolean) => void;
  onShiftSelect?: (path: string, additive: boolean) => void;
  onOpen: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onWarmContextMenu?: (entry: FsEntry, shiftKey: boolean) => void;
  setDragPayload: (ev: React.DragEvent, path: string) => void;
  acceptsDrop: (ev: React.DragEvent) => boolean;
  dropItems: (ev: React.DragEvent) => string[];
  onDropInto?: (targetDirPath: string, items: string[]) => void;
  setDragOverPath: React.Dispatch<React.SetStateAction<string | null>>;
  rename: (entry: FsEntry) => React.ReactNode;
}

function getRelativeFolder(entryPath: string, currentPath?: string): string | null {
  if (!currentPath) return null;
  const normCurrent = currentPath.replace(/[\\/]+$/, "").toLowerCase();
  const lastSlash = Math.max(entryPath.lastIndexOf("\\"), entryPath.lastIndexOf("/"));
  if (lastSlash <= 0) return null;
  const parent = entryPath.slice(0, lastSlash);
  const normParent = parent.replace(/[\\/]+$/, "").toLowerCase();
  if (normParent === normCurrent) return null;

  if (normParent.startsWith(normCurrent)) {
    const rel = parent.slice(normCurrent.length).replace(/^[\\/]+/, "");
    return rel || null;
  }
  return null;
}

function rowEqual(
  prev: { e: FsEntry; ctx: RowCtx },
  next: { e: FsEntry; ctx: RowCtx },
): boolean {
  if (prev.e !== next.e) return false;
  const p = prev.e.path;
  if (prev.ctx.selected.has(p) !== next.ctx.selected.has(p)) return false;
  if (prev.ctx.cutPaths.has(p) !== next.ctx.cutPaths.has(p)) return false;
  if ((prev.ctx.dragOverPath === p) !== (next.ctx.dragOverPath === p)) return false;
  return (
    prev.ctx.zoom === next.ctx.zoom &&
    prev.ctx.colTemplate === next.ctx.colTemplate &&
    prev.ctx.currentPath === next.ctx.currentPath &&
    prev.ctx.rename === next.ctx.rename &&
    prev.ctx.onSelect === next.ctx.onSelect &&
    prev.ctx.onShiftSelect === next.ctx.onShiftSelect &&
    prev.ctx.onOpen === next.ctx.onOpen &&
    prev.ctx.onContextMenu === next.ctx.onContextMenu &&
    prev.ctx.onWarmContextMenu === next.ctx.onWarmContextMenu &&
    prev.ctx.setDragPayload === next.ctx.setDragPayload &&
    prev.ctx.acceptsDrop === next.ctx.acceptsDrop &&
    prev.ctx.dropItems === next.ctx.dropItems &&
    prev.ctx.onDropInto === next.ctx.onDropInto &&
    prev.ctx.setDragOverPath === next.ctx.setDragOverPath
  );
}

let hoverWarmTimer = 0;
function scheduleRowWarm(
  cb: ((entry: FsEntry, shiftKey: boolean) => void) | undefined,
  entry: FsEntry,
) {
  if (!cb) return;
  window.clearTimeout(hoverWarmTimer);
  hoverWarmTimer = window.setTimeout(() => cb(entry, false), 25);
}

function ColGrip({
  index,
  onDown,
  active,
}: {
  index: number;
  onDown: (index: number) => (ev: React.MouseEvent) => void;
  active: boolean;
}) {
  return (
    <span
      onMouseDown={onDown(index)}
      data-tooltip="Drag to resize column"
      className="group/grip absolute right-[-9px] top-[-6px] flex h-[calc(100%+12px)] w-[18px] cursor-col-resize items-stretch justify-center"
    >
      <span
        className={`w-px transition-colors ${
          active ? "bg-[#0078d4]" : "bg-[#3d3d3d] group-hover/grip:bg-[#0078d4]"
        }`}
      />
    </span>
  );
}

/** Explorer Details-view row: Name | Date modified | Type | Size */
const ListRow = memo(function ListRow({ e, ctx }: { e: FsEntry; ctx: RowCtx }) {
  const {
    zoom,
    dragOverPath,
    selected,
    cutPaths,
    onSelect,
    onShiftSelect,
    onOpen,
    onContextMenu,
    onWarmContextMenu,
    setDragPayload,
    acceptsDrop,
    dropItems,
    onDropInto,
    setDragOverPath,
    rename,
  } = ctx;
  const isSel = selected.has(e.path);
  const isCut = cutPaths.has(e.path);
  const dropEnabled = !!(e.is_dir && onDropInto);
  const compact = zoom < 0.95;
  const relFolder = getRelativeFolder(e.path, ctx.currentPath);

  return (
    <div
      data-path={e.path}
      data-drop-path={e.is_dir ? e.path : undefined}
      onMouseEnter={() => scheduleRowWarm(onWarmContextMenu, e)}
      onMouseLeave={() => window.clearTimeout(hoverWarmTimer)}
      onMouseDown={(ev) => {
        if (ev.button === 2) {
          window.clearTimeout(hoverWarmTimer);
          if (!selected.has(e.path)) onSelect(e.path, false);
          onWarmContextMenu?.(e, ev.shiftKey);
        }
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        if (ev.shiftKey) onShiftSelect?.(e.path, ev.ctrlKey || ev.metaKey);
        else onSelect(e.path, ev.ctrlKey || ev.metaKey);
      }}
      onDoubleClick={() => onOpen(e)}
      draggable
      onDragStart={(ev) => setDragPayload(ev, e.path)}
      onDragOver={
        dropEnabled
          ? (ev) => {
              if (acceptsDrop(ev)) {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setDragOverPath(e.path);
              }
            }
          : undefined
      }
      onDragLeave={() => setDragOverPath((p) => (p === e.path ? null : p))}
      onDrop={
        dropEnabled
          ? (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              setDragOverPath(null);
              const items = dropItems(ev);
              if (items.length) onDropInto!(e.path, items);
            }
          : undefined
      }
      onContextMenu={(ev) => {
        ev.stopPropagation();
        if (!selected.has(e.path)) onSelect(e.path, false);
        onContextMenu(ev, e);
      }}
      style={{ gridTemplateColumns: ctx.colTemplate, width: "max-content" }}
      className={`grid cursor-default items-center gap-3 rounded-[4px] px-3 ${
        compact ? "py-0.5" : "py-1"
      } text-[12.5px] transition-colors ${
        isSel
          ? "bg-[#383838] text-white ring-1 ring-inset ring-[#505050]"
          : "text-neutral-200 hover:bg-[#2a2a2a]"
      } ${e.is_hidden || isCut ? "opacity-55" : ""} ${
        dragOverPath === e.path ? "bg-[#323232] ring-2 ring-[#0078d4]" : ""
      }`}
    >
      <span className="flex items-center gap-2.5 overflow-hidden min-w-0">
        <EntryIcon entry={e} size={Math.round(18 * Math.max(0.85, zoom))} className="shrink-0" />
        {rename(e) ?? (
          <span className="truncate flex items-baseline gap-1.5 min-w-0">
            <span className="truncate">{e.name}</span>
            {relFolder && (
              <span className="truncate text-[11px] text-neutral-400 opacity-70 font-normal shrink-0">
                in {relFolder}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="truncate text-neutral-400">{e.modified}</span>
      <span className="truncate text-neutral-400">{e.item_type}</span>
      <span className="truncate text-neutral-400">{e.size}</span>
    </div>
  );
}, rowEqual);

const GridTile = memo(function GridTile({ e, ctx }: { e: FsEntry; ctx: RowCtx }) {
  const {
    zoom,
    dragOverPath,
    selected,
    cutPaths,
    onSelect,
    onShiftSelect,
    onOpen,
    onContextMenu,
    onWarmContextMenu,
    setDragPayload,
    acceptsDrop,
    dropItems,
    onDropInto,
    setDragOverPath,
    rename,
  } = ctx;
  const isSel = selected.has(e.path);
  const isCut = cutPaths.has(e.path);
  const dropEnabled = !!(e.is_dir && onDropInto);
  const relFolder = getRelativeFolder(e.path, ctx.currentPath);
  return (
    <div
      data-path={e.path}
      data-drop-path={e.is_dir ? e.path : undefined}
      onMouseEnter={() => scheduleRowWarm(onWarmContextMenu, e)}
      onMouseLeave={() => window.clearTimeout(hoverWarmTimer)}
      onMouseDown={(ev) => {
        if (ev.button === 2) {
          window.clearTimeout(hoverWarmTimer);
          if (!selected.has(e.path)) onSelect(e.path, false);
          onWarmContextMenu?.(e, ev.shiftKey);
        }
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        if (ev.shiftKey) onShiftSelect?.(e.path, ev.ctrlKey || ev.metaKey);
        else onSelect(e.path, ev.ctrlKey || ev.metaKey);
      }}
      onDoubleClick={() => onOpen(e)}
      draggable
      onDragStart={(ev) => setDragPayload(ev, e.path)}
      onDragOver={
        dropEnabled
          ? (ev) => {
              if (acceptsDrop(ev)) {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setDragOverPath(e.path);
              }
            }
          : undefined
      }
      onDragLeave={() => setDragOverPath((p) => (p === e.path ? null : p))}
      onDrop={
        dropEnabled
          ? (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              setDragOverPath(null);
              const items = dropItems(ev);
              if (items.length) onDropInto!(e.path, items);
            }
          : undefined
      }
      onContextMenu={(ev) => {
        ev.stopPropagation();
        if (!selected.has(e.path)) onSelect(e.path, false);
        onContextMenu(ev, e);
      }}
      className={`flex cursor-default flex-col items-center gap-1 rounded-[5px] px-2 py-2 transition-colors ${
        isSel ? "bg-[#383838] ring-1 ring-inset ring-[#505050]" : "hover:bg-[#2a2a2a]"
      } ${e.is_hidden || isCut ? "opacity-55" : ""} ${
        dragOverPath === e.path ? "bg-[#323232] ring-2 ring-[#0078d4]" : ""
      }`}
    >
      <div
        className="flex items-center justify-center"
        style={{ height: Math.round(48 * zoom), width: Math.round(48 * zoom) }}
      >
        <EntryIcon
          entry={e}
          size={Math.round(48 * zoom)}
          className="max-h-full max-w-full text-neutral-400"
        />
      </div>
      {rename(e) ?? (
        <div className="flex flex-col items-center w-full min-w-0 px-0.5">
          <span
            className="line-clamp-2 w-full break-words text-center leading-[1.25] text-neutral-200"
            style={{ fontSize: Math.round(12 * Math.min(1.4, Math.max(0.9, zoom))) }}
            data-tooltip={e.name}
            data-tooltip-truncated="true"
          >
            {e.name}
          </span>
          {relFolder && (
            <span
              className="text-[10px] text-neutral-400 truncate max-w-full opacity-70 mt-0.5"
              title={`in ${relFolder}`}
            >
              in {relFolder}
            </span>
          )}
        </div>
      )}
    </div>
  );
}, rowEqual);

const EMPTY_SET = new Set<string>();

function groupBucketOf(e: FsEntry, key: GroupByKey): string {
  if (key === "type") return e.item_type || "File";
  if (key === "name") {
    const ch = (e.name[0] ?? "").toUpperCase();
    if (ch >= "A" && ch <= "H") return "A – H";
    if (ch >= "I" && ch <= "P") return "I – P";
    if (ch >= "Q" && ch <= "Z") return "Q – Z";
    return "0 – 9 & Symbols";
  }
  if (key === "size") {
    if (e.is_dir) return "Folders";
    const m = e.size.trim().match(/^([\d.,]+)\s*(bytes|KB|MB|GB|TB)$/i);
    if (!m) return "Unspecified";
    const v = parseFloat(m[1].replace(",", "."));
    const u = m[2].toUpperCase();
    const bytes =
      v *
      (u === "TB"
        ? 1024 ** 4
        : u === "GB"
          ? 1024 ** 3
          : u === "MB"
            ? 1024 ** 2
            : u === "KB"
              ? 1024
              : 1);
    if (bytes === 0) return "Empty (0 KB)";
    if (bytes <= 16 * 1024) return "Tiny (0 – 16 KB)";
    if (bytes <= 1024 * 1024) return "Small (16 KB – 1 MB)";
    if (bytes <= 128 * 1024 * 1024) return "Medium (1 – 128 MB)";
    if (bytes <= 1024 * 1024 * 1024) return "Large (128 MB – 1 GB)";
    return "Huge (> 1 GB)";
  }
  if (key === "date") {
    const m = e.modified.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return "Older";
    const dt = new Date(+m[3], +m[2] - 1, +m[1]);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor((today.getTime() - dt.getTime()) / 86_400_000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays <= 7) return "Earlier this week";
    if (diffDays <= 31) return "Earlier this month";
    if (dt.getFullYear() === now.getFullYear()) return "Earlier this year";
    return "A long time ago";
  }
  return "";
}

export default function FileView({
  entries,
  error,
  loading,
  view,
  zoom = 1,
  onZoom,
  selected,
  cutPaths = EMPTY_SET,
  groupBy = "none",
  currentPath,
  searchQuery = "",
  isSearching = false,
  onSelect,
  onSelectRange,
  onShiftSelect,
  sortKey = "name",
  sortDir = 1,
  onSort,
  onOpen,
  onContextMenu,
  onWarmContextMenu,
  renamingPath = null,
  onRenameConfirm,
  onRenameCancel,
  onDropInto,
}: Props) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groupBy]);

  const setDragPayload = useCallback(
    async (ev: React.DragEvent, path: string) => {
      ev.preventDefault();
      if (!selected.has(path)) {
        onSelect(path, false);
      }
      const items = selected.has(path) ? [...selected] : [path];

      try {
        let iconPath = "";
        try {
          const entry = entries.find((x) => x.path === path);
          const name = path.split(/[\\/]/).pop() ?? "";
          const dot = name.lastIndexOf(".");
          const ext = entry?.is_dir || dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
          const res = await api.getEntryIconsBatch([
            { key: "drag", path, isDir: !!entry?.is_dir, ext, size: 48, preview: false },
          ]);
          if (res[0]?.url) iconPath = res[0].url;
        } catch {}
        if (!iconPath) iconPath = cachedDragIconPath || (await api.getDragIconPath());
        await startDrag(
          {
            item: items,
            icon: iconPath,
          },
          (payload) => {
            if (payload && payload.result === "Dropped") {
              try {
                const scale = window.devicePixelRatio || 1;
                const screenCssX = Number(payload.cursorPos.x) / scale;
                const screenCssY = Number(payload.cursorPos.y) / scale;
                const clientX = screenCssX - (window.screenLeft ?? window.screenX);
                const clientY = screenCssY - (window.screenTop ?? window.screenY);
                if (
                  clientX >= 0 &&
                  clientX <= window.innerWidth &&
                  clientY >= 0 &&
                  clientY <= window.innerHeight
                ) {
                  const el = document.elementFromPoint(clientX, clientY);
                  const dropPath = el?.closest("[data-drop-path]")?.getAttribute("data-drop-path");
                  if (dropPath && onDropInto && !items.includes(dropPath)) {
                    onDropInto(dropPath, items);
                  }
                }
              } catch (err) {
                console.error("Native drop target calculation error:", err);
              }
            }
          },
        );
      } catch (err) {
        console.error("Native drag failed:", err);
      }
    },
    [selected, onSelect, onDropInto, entries],
  );

  const acceptsDrop = useCallback(
    (ev: React.DragEvent) =>
      Array.from(ev.dataTransfer.types).includes("application/x-file-paths") ||
      Array.from(ev.dataTransfer.types).includes("Files"),
    [],
  );

  const dropItems = useCallback((ev: React.DragEvent): string[] => {
    try {
      const raw = ev.dataTransfer.getData("application/x-file-paths");
      const arr = JSON.parse(raw) as string[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }, []);

  const listRename = useCallback(
    (e: FsEntry) =>
      renamingPath === e.path ? (
        <InlineRenameInput
          initial={e.name}
          onConfirm={onRenameConfirm}
          onCancel={onRenameCancel}
          className="min-w-0 flex-1 rounded border border-[#0078d4] bg-[#1b1b1b] px-1 py-0 text-[12.5px] text-white outline-none selection:bg-[#0078d4]"
        />
      ) : null,
    [renamingPath, onRenameConfirm, onRenameCancel],
  );
  const gridRename = useCallback(
    (e: FsEntry) =>
      renamingPath === e.path ? (
        <InlineRenameInput
          initial={e.name}
          onConfirm={onRenameConfirm}
          onCancel={onRenameCancel}
          className="w-full rounded border border-[#0078d4] bg-[#1b1b1b] px-1 py-0 text-center leading-[1.25] text-white outline-none selection:bg-[#0078d4]"
        />
      ) : null,
    [renamingPath, onRenameConfirm, onRenameCancel],
  );

  const DEFAULT_COLS = [310, 155, 165, 95];
  const [cols, setCols] = useState<number[]>(() => {
    try {
      const px = JSON.parse(localStorage.getItem("explorer-cols-v2") ?? "") as unknown;
      if (Array.isArray(px) && px.length === 4 && px.every((n) => typeof n === "number" && n >= 50)) {
        return px as number[];
      }
    } catch {}
    return DEFAULT_COLS;
  });
  useEffect(() => {
    try {
      localStorage.setItem("explorer-cols-v2", JSON.stringify(cols));
    } catch {}
  }, [cols]);

  const colTemplate = cols.map((w) => `${Math.round(w)}px`).join(" ");
  const headerRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const [resizing, setResizing] = useState<number | null>(null);

  const startResize = (index: number) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setResizing(index);
    const startX = ev.clientX;
    const start = [...colsRef.current];
    const clamp = (n: number) => Math.max(65, n);
    const onMove = (m: MouseEvent) => {
      const dx = m.clientX - startX;
      const next = [...start];
      next[index] = clamp(start[index] + dx);
      setCols(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const ctx = useMemo<RowCtx>(
    () => ({
      zoom,
      colTemplate,
      dragOverPath,
      selected,
      cutPaths,
      currentPath,
      onSelect,
      onShiftSelect,
      onOpen,
      onContextMenu,
      onWarmContextMenu,
      setDragPayload,
      acceptsDrop,
      dropItems,
      onDropInto,
      setDragOverPath,
      rename: listRename,
    }),
    [
      zoom,
      colTemplate,
      dragOverPath,
      selected,
      cutPaths,
      currentPath,
      onSelect,
      onShiftSelect,
      onOpen,
      onContextMenu,
      onWarmContextMenu,
      setDragPayload,
      acceptsDrop,
      dropItems,
      onDropInto,
      listRename,
    ],
  );

  const RENDER_FIRST = 250;
  const RENDER_STEP = 500;
  const [renderLimit, setRenderLimit] = useState(RENDER_FIRST);
  useEffect(() => {
    setRenderLimit(RENDER_FIRST);
    if (entries.length <= RENDER_FIRST) return;
    let n = RENDER_FIRST;
    const id = window.setInterval(() => {
      n += RENDER_STEP;
      if (n >= entries.length) {
        window.clearInterval(id);
        setRenderLimit(entries.length);
      } else {
        setRenderLimit(n);
      }
    }, 40);
    return () => window.clearInterval(id);
  }, [entries]);
  const shownEntries =
    renderLimit >= entries.length ? entries : entries.slice(0, renderLimit);

  const groupedSections = useMemo(() => {
    if (groupBy === "none") return null;
    const map = new Map<string, FsEntry[]>();
    for (const e of shownEntries) {
      const g = groupBucketOf(e, groupBy);
      const arr = map.get(g);
      if (arr) arr.push(e);
      else map.set(g, [e]);
    }
    return [...map.entries()];
  }, [shownEntries, groupBy]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastDragEndRef = useRef(0);
  const marqueeRef = useRef<{
    ax: number;
    ay: number;
    acx: number;
    acy: number;
    additive: boolean;
    moved: boolean;
    lastCX: number;
    lastCY: number;
  } | null>(null);
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);

  const updateMarquee = useCallback(
    (cx: number, cy: number) => {
      const m = marqueeRef.current;
      const el = scrollRef.current;
      if (!m || !el) return;
      m.lastCX = cx;
      m.lastCY = cy;
      const r = el.getBoundingClientRect();
      if (cy < r.top + 48) el.scrollTop -= 14;
      else if (cy > r.bottom - 48) el.scrollTop += 14;
      if (Math.abs(cx - m.acx) + Math.abs(cy - m.acy) > 6) m.moved = true;
      const ccx = Math.min(Math.max(cx, r.left), r.right);
      const ccy = Math.min(Math.max(cy, r.top), r.bottom);
      const cacx = Math.min(Math.max(m.acx, r.left), r.right);
      const cacy = Math.min(Math.max(m.acy, r.top), r.bottom);
      const x = ccx - r.left + el.scrollLeft;
      const y = ccy - r.top + el.scrollTop;
      setMarquee({ x0: m.ax, y0: m.ay, x1: x, y1: y });
      const vx0 = Math.min(cacx, ccx);
      const vx1 = Math.max(cacx, ccx);
      const vy0 = Math.min(cacy, ccy);
      const vy1 = Math.max(cacy, ccy);
      const paths: string[] = [];
      el.querySelectorAll("[data-path]").forEach((node) => {
        const br = (node as HTMLElement).getBoundingClientRect();
        if (br.left < vx1 && br.right > vx0 && br.top < vy1 && br.bottom > vy0) {
          const p = (node as HTMLElement).dataset.path;
          if (p) paths.push(p);
        }
      });
      onSelectRange(paths, m.additive);
    },
    [onSelectRange],
  );

  const beginMarquee = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    if (ev.defaultPrevented) return;
    if ((ev.target as HTMLElement).closest("[data-path], input, button")) return;
    ev.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    marqueeRef.current = {
      ax: ev.clientX - r.left + el.scrollLeft,
      ay: ev.clientY - r.top + el.scrollTop,
      acx: ev.clientX,
      acy: ev.clientY,
      additive: ev.ctrlKey || ev.metaKey,
      moved: false,
      lastCX: ev.clientX,
      lastCY: ev.clientY,
    };
    setMarquee({
      x0: marqueeRef.current.ax,
      y0: marqueeRef.current.ay,
      x1: marqueeRef.current.ax,
      y1: marqueeRef.current.ay,
    });
    const onMove = (m: MouseEvent) => updateMarquee(m.clientX, m.clientY);
    const onScrollDuring = () => {
      const cur = marqueeRef.current;
      if (cur) updateMarquee(cur.lastCX, cur.lastCY);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("scroll", onScrollDuring);
      const wasDrag = marqueeRef.current?.moved ?? false;
      marqueeRef.current = null;
      setMarquee(null);
      if (wasDrag) lastDragEndRef.current = Date.now();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    el.addEventListener("scroll", onScrollDuring);
  };

  const cbRef = useRef(onZoom);
  cbRef.current = onZoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      if (!ev.ctrlKey || !cbRef.current) return;
      ev.preventDefault();
      cbRef.current(ev.deltaY < 0 ? 0.2 : -0.2);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [loading, error]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[#191919] text-neutral-500">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[#191919] text-center text-neutral-500">
        {error}
      </div>
    );
  }

  function InlineRenameInput({
    initial,
    onConfirm,
    onCancel,
    className,
  }: {
    initial: string;
    onConfirm: (name: string) => void;
    onCancel: () => void;
    className?: string;
  }) {
    const ref = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState(initial);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const dot = initial.lastIndexOf(".");
      const stem = dot > 0 ? initial.slice(0, dot) : initial;
      el.setSelectionRange(0, stem.length);
    }, []);
    return (
      <input
        ref={ref}
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") onConfirm(value.trim());
          else if (ev.key === "Escape") onCancel();
        }}
        onMouseDown={(ev) => ev.stopPropagation()}
        onBlur={() => onCancel()}
        autoFocus
        className={className}
        onClick={(ev) => ev.stopPropagation()}
      />
    );
  }

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const renderGroupHeader = (label: string, count: number) => {
    const collapsed = collapsedGroups.has(label);
    return (
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          toggleGroup(label);
        }}
        className="mt-2 mb-1 flex w-full items-center gap-2 px-1 py-1 text-left text-[13px] font-medium text-[#8ab4f8] hover:text-white"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="shrink-0">
          {label} ({count})
        </span>
        <span className="ml-1 h-px flex-1 bg-[#303030]" />
      </button>
    );
  };

  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(104 * zoom)}px, 1fr))`,
  };

  return (
    <div
      ref={scrollRef}
      className={`relative flex-1 overflow-auto bg-[#191919] px-3 pb-4 ${
        marquee ? "select-none" : ""
      }`}
      onClick={(ev) => {
        if (Date.now() - lastDragEndRef.current < 350) return;
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
        onSelect("", false);
      }}
      onMouseDown={beginMarquee}
      onContextMenu={(e) => onContextMenu(e, null)}
    >
      {marquee && marqueeRef.current?.moved && (
        <div
          className="pointer-events-none absolute z-20 border border-[#0078d4] bg-[#0078d4]/20"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {view === "list" ? (
        <>
          <div
            ref={headerRef}
            className="sticky top-0 z-10 grid w-fit gap-3 border-b border-[#2e2e2e] bg-[#191919] px-3 py-1.5 text-[12px] text-neutral-400"
            style={{ gridTemplateColumns: colTemplate, minWidth: "100%" }}
          >
            <button
              type="button"
              onClick={() => onSort?.("name")}
              title="Sort by name"
              className="relative flex items-center gap-1.5 text-left outline-none transition-colors hover:text-white"
            >
              Name
              {sortKey === "name" && (
                <span className="text-[9px] text-neutral-300">{sortDir === 1 ? "▲" : "▼"}</span>
              )}
              <ColGrip index={0} onDown={startResize} active={resizing === 0} />
            </button>
            <button
              type="button"
              onClick={() => onSort?.("date")}
              title="Sort by date modified"
              className="relative flex items-center gap-1.5 text-left outline-none transition-colors hover:text-white"
            >
              Date modified
              {sortKey === "date" && (
                <span className="text-[9px] text-neutral-300">{sortDir === 1 ? "▲" : "▼"}</span>
              )}
              <ColGrip index={1} onDown={startResize} active={resizing === 1} />
            </button>
            <button
              type="button"
              onClick={() => onSort?.("type")}
              title="Sort by type"
              className="relative flex items-center gap-1.5 text-left outline-none transition-colors hover:text-white"
            >
              Type
              {sortKey === "type" && (
                <span className="text-[9px] text-neutral-300">{sortDir === 1 ? "▲" : "▼"}</span>
              )}
              <ColGrip index={2} onDown={startResize} active={resizing === 2} />
            </button>
            <button
              type="button"
              onClick={() => onSort?.("size")}
              title="Sort by size"
              className="relative flex items-center gap-1.5 text-left outline-none transition-colors hover:text-white"
            >
              Size
              {sortKey === "size" && (
                <span className="text-[9px] text-neutral-300">{sortDir === 1 ? "▲" : "▼"}</span>
              )}
              <ColGrip index={3} onDown={startResize} active={resizing === 3} />
            </button>
          </div>

          {groupedSections ? (
            <div className="mt-1">
              {groupedSections.map(([gName, gItems]) => (
                <div key={gName}>
                  {renderGroupHeader(gName, gItems.length)}
                  {!collapsedGroups.has(gName) && (
                    <div className="flex flex-col items-start gap-1">
                      {gItems.map((e) => (
                        <ListRow key={e.path} e={e} ctx={ctx} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-1 flex flex-col items-start gap-1">
              {shownEntries.map((e) => (
                <ListRow key={e.path} e={e} ctx={ctx} />
              ))}
            </div>
          )}
        </>
      ) : groupedSections ? (
        <div className="pt-1">
          {groupedSections.map(([gName, gItems]) => (
            <div key={gName}>
              {renderGroupHeader(gName, gItems.length)}
              {!collapsedGroups.has(gName) && (
                <div className="grid content-start items-start gap-1" style={gridStyle}>
                  {gItems.map((e) => (
                    <GridTile key={e.path} e={e} ctx={{ ...ctx, rename: gridRename }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="grid min-h-[65vh] content-start items-start gap-1 pt-2"
          style={gridStyle}
        >
          {shownEntries.map((e) => (
            <GridTile key={e.path} e={e} ctx={{ ...ctx, rename: gridRename }} />
          ))}
        </div>
      )}

      {entries.length === 0 && !error && (
        <div className="mt-24 flex flex-col items-center justify-center gap-2 text-neutral-500">
          {isSearching ? (
            <>
              <Loader2 className="animate-spin text-sky-400" size={20} />
              <span className="text-[13px] text-neutral-400">Searching subfolders for "{searchQuery}"…</span>
            </>
          ) : searchQuery ? (
            <span className="text-[13px] text-neutral-400">No items match "{searchQuery}"</span>
          ) : (
            <span>This folder is empty.</span>
          )}
        </div>
      )}
      {shownEntries.length < entries.length && (
        <div className="py-3 text-center text-[12px] text-neutral-500">
          Showing {shownEntries.length} of {entries.length} — loading more…
        </div>
      )}
    </div>
  );
}
