import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Loader2,
  RotateCw,
  Search,
  X,
} from "lucide-react";

interface Props {
  path: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  /** Live folder filter (client-side, updates as you type). */
  query: string;
  onQuery: (q: string) => void;
  loading?: boolean;
  onSearchSubfolders?: (q: string) => void;
  isSearchingSubfolders?: boolean;
  /** Increment to focus and select the address bar (Ctrl+L / Alt+D / F4). */
  focusAddressSignal?: number;
  /** Drop dragged file items onto a breadcrumb segment = move into it. */
  onDropInto?: (targetDirPath: string, items: string[]) => void;
}

interface Segment {
  name: string;
  path: string; // full path up to and including this segment
}

const VIRTUAL_NAMES: Record<string, string> = {
  "shell:ThisPC": "This PC",
  "shell:Network": "Network",
  "shell:RecycleBinFolder": "Recycle Bin",
};

function splitPath(path: string): Segment[] {
  // Virtual pages show a single friendly crumb instead of path segments.
  if (VIRTUAL_NAMES[path]) return [{ name: VIRTUAL_NAMES[path], path }];
  const clean = path.replace(/\\+$/, "");
  const parts = clean.split("\\").filter(Boolean);
  const segs: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = segs[i - 1];
    if (i === 0 && /^[A-Z]:$/i.test(parts[i])) {
      segs.push({ name: parts[i], path: parts[i] + "\\" });
    } else if (prev) {
      segs.push({ name: parts[i], path: prev.path + parts[i] + "\\" });
    } else {
      segs.push({ name: parts[i], path: parts[i] + "\\" });
    }
  }
  return segs;
}

const btn =
  "flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-[#2d2d2d] hover:text-white disabled:pointer-events-none disabled:opacity-30";

export default function Topbar({
  path,
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  onRefresh,
  onNavigate,
  query,
  onQuery,
  loading = false,
  onSearchSubfolders,
  isSearchingSubfolders = false,
  focusAddressSignal = 0,
  onDropInto,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const addrInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [dropSeg, setDropSeg] = useState<string | null>(null);

  const segAccepts = (ev: React.DragEvent) => {
    const types = Array.from(ev.dataTransfer.types);
    return (types.includes("application/x-file-paths") || types.includes("Files")) && !!onDropInto;
  };

  const segDrop = (segPath: string) => (ev: React.DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropSeg(null);
    if (!onDropInto) return;
    try {
      const arr = JSON.parse(ev.dataTransfer.getData("application/x-file-paths")) as string[];
      if (Array.isArray(arr) && arr.length && segPath !== path.replace(/\\+$/, "")) {
        onDropInto(segPath, arr);
      }
    } catch {
      /* ignore malformed drops */
    }
  };

  useEffect(() => {
    setDraft(path);
  }, [path]);

  useEffect(() => {
    if (focusAddressSignal > 0) {
      setDraft(path);
      setEditing(true);
    }
  }, [focusAddressSignal, path]);

  useEffect(() => {
    if (editing && addrInputRef.current) {
      addrInputRef.current.focus();
      addrInputRef.current.select();
    }
  }, [editing]);

  const segments = useMemo(() => splitPath(path), [path]);
  const activeName = segments[segments.length - 1]?.name ?? "Folder";
  const canUp = path !== "shell:ThisPC" && path !== "shell:RecycleBinFolder";

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== path.replace(/\\+$/, "")) onNavigate(t);
    else setDraft(path);
  };

  return (
    <div className="flex items-center gap-1 border-b border-[#2d2d2d] bg-[#191919] px-2.5 py-1.5">
      <button
        className={btn}
        onClick={onBack}
        disabled={!canBack}
        data-tooltip="Back (Alt+←)"
        aria-label="Back"
      >
        <ArrowLeft size={16} />
      </button>
      <button
        className={btn}
        onClick={onForward}
        disabled={!canForward}
        data-tooltip="Forward (Alt+→)"
        aria-label="Forward"
      >
        <ArrowRight size={16} />
      </button>
      <button
        className={btn}
        onClick={onUp}
        disabled={!canUp}
        data-tooltip="Up one level (Alt+↑)"
        aria-label="Up one level"
      >
        <ArrowUp size={16} />
      </button>
      <button
        className={btn}
        onClick={onRefresh}
        data-tooltip="Refresh (F5)"
        aria-label="Refresh"
      >
        <RotateCw size={15} />
      </button>

      <div
        className="mx-1 flex h-8 flex-1 items-center overflow-hidden rounded-md border border-[#303030] bg-[#222222] hover:border-[#454545] focus-within:border-[#0078d4]"
        onMouseEnter={() => {
          if (!editing) setDraft(path);
        }}
      >
        {editing ? (
          <input
            ref={addrInputRef}
            autoFocus
            className="allow-select h-full w-full rounded-md bg-[#222222] px-3 text-[13px] text-neutral-200 outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(path);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div
            className="allow-scroll flex h-full w-full items-center gap-0.5 overflow-x-auto px-2"
            onClick={(e) => {
              if (e.target === e.currentTarget) setEditing(true);
            }}
          >
            {segments.map((seg, i) => {
              const isLast = i === segments.length - 1;
              return (
                <span key={seg.path} className="flex shrink-0 items-center">
                  {i > 0 && <ChevronRight size={12} className="text-neutral-500" />}
                  <button
                    type="button"
                    data-drop-path={!isLast ? seg.path : undefined}
                    onClick={() => onNavigate(seg.path)}
                    onKeyDown={(e) => e.key === "Enter" && onNavigate(seg.path)}
                    onDragOver={(ev) => {
                      if (segAccepts(ev) && !isLast) {
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = "move";
                        setDropSeg(seg.path);
                      }
                    }}
                    onDragLeave={() => setDropSeg((p) => (p === seg.path ? null : p))}
                    onDrop={segDrop(seg.path)}
                    className={`flex items-center justify-center rounded px-1.5 py-0.5 text-[12.5px] transition-colors ${
                      isLast
                        ? "text-white hover:bg-[#303030]"
                        : "text-neutral-300 hover:bg-[#303030] hover:text-white"
                    } ${dropSeg === seg.path && !isLast ? "bg-[#323232] ring-2 ring-[#0078d4]" : ""}`}
                  >
                    {seg.name}
                  </button>
                </span>
              );
            })}
            <span
              className="h-full min-w-8 flex-1 cursor-text"
              onClick={() => setEditing(true)}
            />
          </div>
        )}

        {/* Windows Explorer green address bar progress indicator */}
        {(loading || isSearchingSubfolders) && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden rounded-b-md bg-[#2d2d2d]">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400 animate-explorer-progress shadow-[0_0_8px_rgba(16,185,129,0.7)]" />
          </div>
        )}
      </div>

      {/* Fast search — filters the current folder live */}
      <div className="relative flex h-8 w-56 shrink-0 items-center">
        <Search
          size={13.5}
          className="pointer-events-none absolute left-2.5 text-neutral-400"
        />
        <input
          ref={searchRef}
          data-fast-search
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQuery("");
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Enter" && query.trim() && onSearchSubfolders) {
              onSearchSubfolders(query.trim());
            }
          }}
          placeholder={isSearchingSubfolders ? `Searching subfolders…` : `Search ${activeName}`}
          className={`allow-select h-full w-full rounded-md border border-[#303030] bg-[#222222] pl-8 pr-8 text-[12.5px] text-neutral-200 outline-none placeholder:text-neutral-500 hover:border-[#454545] focus:border-[#0078d4] ${
            isSearchingSubfolders ? "ring-1 ring-sky-500" : ""
          }`}
        />
        {query && (
          <div className="absolute right-1.5 flex items-center gap-1">
            {isSearchingSubfolders && (
              <div
                className="flex h-5 w-5 items-center justify-center text-sky-400"
                data-tooltip="Searching subfolders live…"
              >
                <Loader2 size={12} className="animate-spin" />
              </div>
            )}
            <button
              type="button"
              onClick={() => onQuery("")}
              data-tooltip="Clear (Esc)"
              aria-label="Clear search"
              className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-[#303030] hover:text-white"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
