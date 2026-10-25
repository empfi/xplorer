import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Drive, FsEntry } from "../types";
import { api, onDrivesChanged } from "../api";
import EntryIcon from "./EntryIcon";

/** Parse human bytes back to a number for capacity bars ("57,3 GB" -> bytes). */
function parseBytes(human: string): number {
  const m = human.trim().match(/^([\d.,]+)\s*(GB|MB|KB|TB)/i);
  if (!m) return 0;
  const value = parseFloat(m[1].replace(",", "."));
  const mult =
    m[2].toUpperCase() === "TB" ? 1024 ** 4
    : m[2].toUpperCase() === "GB" ? 1024 ** 3
    : m[2].toUpperCase() === "MB" ? 1024 ** 2
    : 1024;
  return value * mult;
}

/** Explorer order: fixed drive letters first, other locals after, then network drives. */
function sortDrives(drives: Drive[]): Drive[] {
  const score = (d: Drive) => (/^[A-Z]:$/.test(d.name) ? 0 : d.is_network ? 2 : 1);
  return [...drives].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

/** Explorer-style "Label (C:)" display name; falls back to the bare letter. */
function displayName(d: Drive): string {
  return d.label ? `${d.label} (${d.name})` : d.name;
}

/** Used-share percentage for capacity bars. */
function usedPct(d: Drive): number {
  const total = parseBytes(d.total);
  if (!total) return 0;
  return Math.max(3, Math.min(100, ((total - parseBytes(d.free)) / total) * 100));
}

/** A drive rendered as a file entry so it gets its real shell icon. */
function driveEntry(d: Drive): FsEntry {
  return {
    name: displayName(d),
    path: d.path,
    is_dir: true,
    is_hidden: false,
    size: "",
    item_type: d.is_network ? "Network Drive" : "Local Disk",
    modified: "",
  };
}

function entryKey(e: FsEntry): string {
  return `${e.item_type}::${e.name}::${e.path}`;
}

// Module-level warm cache so switching back to This PC renders drives and
// network devices in 0ms while refreshing asynchronously in the background.
let cachedDrives: Drive[] | null = null;
let cachedHosts: FsEntry[] | null = null;

interface Props {
  query: string;
  view: "list" | "grid";
  zoom?: number;
  /** Bump to refetch drives + hosts (F5 / refresh button). */
  refreshSignal?: number;
  onOpen: (path: string) => void;
  onBackgroundMenu: (e: React.MouseEvent) => void;
  onEntryMenu?: (e: React.MouseEvent, entry: FsEntry) => void;
  onWarmEntryMenu?: (entry: FsEntry, shiftKey: boolean) => void;
  /** Reports background loading (drives/hosts still resolving) for the tab spinner. */
  onBgLoadingChange?: (loading: boolean) => void;
  /** Move dragged entries into a drive/host (drag & drop). */
  onDropInto?: (targetDirPath: string, items: string[]) => void;
}

export default function ThisPCView({
  query,
  view,
  zoom = 1,
  refreshSignal = 0,
  onOpen,
  onBackgroundMenu,
  onEntryMenu,
  onWarmEntryMenu,
  onDropInto,
  onBgLoadingChange,
}: Props) {
  const [drives, setDrives] = useState<Drive[]>(() => cachedDrives ?? []);
  const [hosts, setHosts] = useState<FsEntry[]>(() => cachedHosts ?? []);
  // Drives and network devices resolve on completely independent async pipelines
  // so neither section ever waits on or blocks the other.
  const [drivesDone, setDrivesDone] = useState<boolean>(() => cachedDrives !== null);
  const [hostsDone, setHostsDone] = useState<boolean>(() => cachedHosts !== null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Section collapse state — the headers look like dropdowns, so they act like them.
  const [drivesOpen, setDrivesOpen] = useState(true);
  const [netOpen, setNetOpen] = useState(true);
  // Bumped by live hot-plug events: refetches ONLY drives (network discovery stays untouched).
  const [driveTick, setDriveTick] = useState(0);
  useEffect(() => onDrivesChanged(() => setDriveTick((n) => n + 1)), []);

  // Independent pipeline #1: Local & network drives + per-drive capacity/label details
  useEffect(() => {
    let alive = true;
    if (!cachedDrives) setDrivesDone(false);
    api
      .getDrives()
      .then((d) => {
        if (!alive) return;
        // Preserve already-known labels/capacities from cache for matching drive letters
        const merged = d.map((drive) => {
          const prev = cachedDrives?.find((p) => p.path === drive.path);
          return prev ? { ...drive, label: prev.label || drive.label, free: prev.free || drive.free, total: prev.total || drive.total } : drive;
        });
        cachedDrives = merged;
        setDrives(merged);
        setDrivesDone(true);
        for (const drive of d) {
          const details = api.getDriveDetails(drive.path);
          const timeout = new Promise<null>((res) =>
            window.setTimeout(() => res(null), 3000),
          );
          Promise.race([details, timeout])
            .then((det) => {
              if (!alive || !det) return;
              setDrives((prev) => {
                const next = prev.map((x) =>
                  x.path === det.path ? { ...x, ...det } : x,
                );
                cachedDrives = next;
                return next;
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (alive) setDrivesDone(true);
      });
    return () => {
      alive = false;
    };
  }, [refreshSignal, driveTick]);

  // Independent pipeline #2: Local network discovery (WNet + multi-interface SSDP/UPnP)
  useEffect(() => {
    let alive = true;
    if (!cachedHosts) setHostsDone(false);
    api
      .getNetworkHosts()
      .then((h) => {
        if (!alive) return;
        cachedHosts = h;
        setHosts(h);
        setHostsDone(true);
      })
      .catch(() => {
        if (alive) setHostsDone(true);
      });
    return () => {
      alive = false;
    };
  }, [refreshSignal]);

  // Surface background work to the tab icon; clear it on unmount (tab switch).
  useEffect(() => {
    onBgLoadingChange?.(!drivesDone || !hostsDone);
  }, [drivesDone, hostsDone, onBgLoadingChange]);
  useEffect(() => () => onBgLoadingChange?.(false), [onBgLoadingChange]);

  const q = query.trim().toLowerCase();
  const visibleDrives = useMemo(() => {
    const sorted = sortDrives(drives);
    return q ? sorted.filter((d) => d.name.toLowerCase().includes(q)) : sorted;
  }, [drives, q]);
  const visibleHosts = useMemo(
    () => (q ? hosts.filter((h) => h.name.toLowerCase().includes(q)) : hosts),
    [hosts, q],
  );

  const acceptsDrop = useCallback(
    (ev: React.DragEvent) => {
      if (!onDropInto) return false;
      const types = Array.from(ev.dataTransfer.types);
      return types.includes("application/x-file-paths") || types.includes("Files");
    },
    [onDropInto],
  );

  const dropItems = useCallback((ev: React.DragEvent): string[] => {
    try {
      const arr = JSON.parse(ev.dataTransfer.getData("application/x-file-paths")) as string[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }, []);

  const dropEnabled = !!onDropInto;
  const rowDrop = (target: string) => ({
    "data-drop-path": target,
    onDragOver: dropEnabled
      ? (ev: React.DragEvent) => {
          if (!acceptsDrop(ev)) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          setDragOver(target);
        }
      : undefined,
    onDragLeave: () => setDragOver((p) => (p === target ? null : p)),
    onDrop: dropEnabled
      ? (ev: React.DragEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
          setDragOver(null);
          const items = dropItems(ev);
          if (items.length) onDropInto!(target, items);
        }
      : undefined,
  });

  const renderRow = (e: FsEntry, sub?: React.ReactNode) => {
    const k = entryKey(e);
    const isSel = selected === k;
    return (
      <div
        key={k}
        data-path={e.path}
        onMouseDown={(ev) => {
          if (ev.button === 2) {
            setSelected(k);
            onWarmEntryMenu?.(e, ev.shiftKey);
          }
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setSelected(k);
        }}
        onDoubleClick={() => onOpen(e.path)}
        onContextMenu={(ev) => {
          ev.stopPropagation();
          setSelected(k);
          if (onEntryMenu) onEntryMenu(ev, e);
          else onBackgroundMenu(ev);
        }}
        {...rowDrop(e.path)}
        className={`flex cursor-default items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
          isSel ? "bg-[#3b3b3b] text-white" : "text-neutral-300 hover:bg-[#2d2d2d]"
        } ${dragOver === e.path ? "bg-[#323232] ring-2 ring-[#0078d4]" : ""}`}
      >
        <EntryIcon entry={e} size={Math.round(20 * zoom)} perPath className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {sub}
      </div>
    );
  };

  const driveSub = (d: Drive) =>
    d.total ? (
      <span className="flex w-40 shrink-0 items-center gap-2 sm:w-56">
        <span className="h-1.5 min-w-6 flex-1 overflow-hidden rounded bg-[#2d2d2d]">
          <span className="block h-full bg-[#0078d4]" style={{ width: `${usedPct(d)}%` }} />
        </span>
        <span className="shrink-0 truncate whitespace-nowrap text-[11.5px] text-neutral-500">
          {d.free} free of {d.total}
        </span>
      </span>
    ) : undefined;

  const section = (title: string, count: number, open: boolean, onToggle: () => void) => (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded px-3 pb-1 pt-3 text-left text-[12.5px] text-neutral-300 hover:text-white"
    >
      {open ? (
        <ChevronDown size={13} className="text-neutral-500" />
      ) : (
        <ChevronRight size={13} className="text-neutral-500" />
      )}
      <span>
        {title} ({count})
      </span>
    </button>
  );

  // Explorer-style horizontal cards: icon left, name + bar + free-text right.
  const renderTile = (e: FsEntry, sub?: React.ReactNode) => {
    const k = entryKey(e);
    const isSel = selected === k;
    return (
      <div
        key={k}
        data-path={e.path}
        onMouseDown={(ev) => {
          if (ev.button === 2) {
            setSelected(k);
            onWarmEntryMenu?.(e, ev.shiftKey);
          }
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          setSelected(k);
        }}
        onDoubleClick={() => onOpen(e.path)}
        onContextMenu={(ev) => {
          ev.stopPropagation();
          setSelected(k);
          if (onEntryMenu) onEntryMenu(ev, e);
          else onBackgroundMenu(ev);
        }}
        {...rowDrop(e.path)}
        className={`flex cursor-default items-center gap-3 self-start rounded-lg px-3 py-2.5 transition-colors ${
          isSel ? "bg-[#3b3b3b]" : "hover:bg-[#2d2d2d]"
        } ${dragOver === e.path ? "bg-[#323232] ring-2 ring-[#0078d4]" : ""}`}
      >
        <EntryIcon entry={e} size={Math.round(40 * zoom)} perPath className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate text-[13px] text-neutral-200 py-0.5 leading-normal"
            data-tooltip={e.name}
            data-tooltip-truncated="true"
          >
            {e.name}
          </span>
          {sub}
        </span>
      </div>
    );
  };

  const tileSub = (d: Drive) =>
    d.total ? (
      <>
        <span className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[#2d2d2d]">
          <span className="block h-full bg-[#0078d4]" style={{ width: `${usedPct(d)}%` }} />
        </span>
        <span className="mt-0.5 truncate text-[11px] text-neutral-500">
          {d.free} free of {d.total}
        </span>
      </>
    ) : undefined;

  const hostSub = (h: FsEntry) => (
    <span className="truncate text-[11px] text-neutral-500">{h.item_type}</span>
  );

  const gridCols = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(230 * zoom)}px, 1fr))`,
  };

  return (
    <div
      className="flex-1 overflow-y-auto bg-[#191919] px-3 pb-3"
      onClick={() => setSelected(null)}
      onContextMenu={(e) => onBackgroundMenu(e)}
    >
      {section("Devices and drives", visibleDrives.length, drivesOpen, () =>
        setDrivesOpen((o) => !o),
      )}
      {drivesOpen &&
        (view === "grid" ? (
          <div className="grid content-start items-start gap-1" style={gridCols}>
            {visibleDrives.map((d) => renderTile(driveEntry(d), tileSub(d)))}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleDrives.map((d) => renderRow(driveEntry(d), driveSub(d)))}
          </div>
        ))}
      {drivesOpen && !drivesDone && (
        <div className="px-6 py-2 text-[12.5px] text-neutral-500">Loading drives…</div>
      )}
      {drivesOpen && drivesDone && !visibleDrives.length && (
        <div className="px-6 py-2 text-[12.5px] text-neutral-500">No drives found</div>
      )}

      {section("Network", visibleHosts.length, netOpen, () => setNetOpen((o) => !o))}
      {netOpen &&
        (view === "grid" ? (
          <div className="grid content-start items-start gap-1" style={gridCols}>
            {visibleHosts.map((h) => renderTile(h, hostSub(h)))}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleHosts.map((h) => renderRow(h, hostSub(h)))}
          </div>
        ))}
      {netOpen && !hostsDone && !visibleHosts.length && (
        <div className="px-6 py-2 text-[12.5px] text-neutral-500">
          Searching the local network…
        </div>
      )}
      {netOpen && hostsDone && !visibleHosts.length && (
        <div className="px-6 py-2 text-[12.5px] text-neutral-500">
          No network devices found
        </div>
      )}

      {/* Empty-state filler so right-click always lands on this page */}
      <div className="min-h-[30vh]" />
    </div>
  );
}
