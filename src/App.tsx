import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardMode,
  DirListing,
  FsEntry,
  GroupByKey,
  HistoryAction,
  ShellContextMenuResponse,
  ShellMenuItem,
  SortKey,
  TransferProgress,
} from "./types";
import { api, onDrivesChanged, onFolderChanged, onTransferProgress } from "./api";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import ThisPCView from "./components/ThisPCView";
import Topbar from "./components/Topbar";
import FileView from "./components/FileView";
import ActionBar, { type ShellNewEntry } from "./components/ActionBar";
import TabBar from "./components/TabBar";
import ContextMenu, { type MenuGroup, type MenuItem } from "./components/ContextMenu";
import InstantTooltip from "./components/InstantTooltip";
import PreviewPane from "./components/PreviewPane";
import TransferDialog from "./components/TransferDialog";
import {
  AppWindow,
  Archive,
  Cast,
  CheckCircle2,
  ClipboardCopy,
  ClipboardPaste,
  CloudUpload,
  ExternalLink,
  FileText,
  FolderPlus,
  History,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Library,
  Link as LinkIcon,
  Link2,
  List,
  Loader2,
  PenLine,
  Pin,
  PinOff,
  Printer,
  RotateCcw,
  Scissors,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Terminal as TerminalIcon,
  Trash2 as Trash2Icon,
  Users,
  type LucideIcon,
} from "lucide-react";

/** Fallback glyphs for Windows shell menu entries that expose no bitmap of their own. */
function fallbackMenuIcon(label: string): LucideIcon | undefined {
  const l = label.replace(/&/g, "").replace(/\.\.\.$/, "").trim().toLowerCase();
  const table: [RegExp, LucideIcon][] = [
    [/^open in new window/, AppWindow],
    [/^open with/, AppWindow],
    [/^open in terminal/, TerminalIcon],
    [/^open$/, ExternalLink],
    [/sync or back up/, CloudUpload],
    [/^give access/, Users],
    [/^share/, Share2],
    [/restore previous versions/, History],
    [/include in library/, Library],
    [/^pin to start/, Pin],
    [/^pin to taskbar/, Pin],
    [/copy as path/, Link2],
    [/^send to/, Send],
    [/^create shortcut/, LinkIcon],
    [/^properties/, Info],
    [/7-zip|winrar|zip|extract|compress|archive/, Archive],
    [/^print/, Printer],
    [/^edit/, PenLine],
    [/scan with|defender/, ShieldCheck],
    [/desktop background/, ImageIcon],
    [/^cast to device/, Cast],
    [/^customize this folder/, Settings],
  ];
  return table.find(([re]) => re.test(l))?.[1];
}

function sizeBytesOf(size: string): number {
  const m = size.trim().match(/^([\d.,]+)\s*(bytes|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const v = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(v)) return 0;
  const u = m[2].toUpperCase();
  return (
    v *
    (u === "TB"
      ? 1024 ** 4
      : u === "GB"
        ? 1024 ** 3
        : u === "MB"
          ? 1024 ** 2
          : u === "KB"
            ? 1024
            : 1)
  );
}

function formatHumanBytes(bytes: number): string {
  if (bytes <= 0) return "";
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

function dateValOf(modified: string): number {
  const m = modified.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
}

function parentPath(path: string): string {
  const norm = path.replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  if (idx <= 2) return norm.slice(0, idx + 1) || "C:\\";
  return norm.slice(0, idx);
}

interface Tab {
  id: number;
  path: string;
  history: string[];
  hIndex: number;
  listing: DirListing;
  loading: boolean;
  bgLoading: boolean;
  selected: Set<string>;
  view: "list" | "grid";
  zoom: number;
}

let nextTabId = 2;

function getInitialPath(): string {
  try {
    const cached = localStorage.getItem("downloads-path");
    if (cached) return cached;
  } catch {}
  return "C:\\";
}

function newTab(path = getInitialPath()): Tab {
  return {
    id: nextTabId++,
    path,
    history: [path],
    hIndex: 0,
    listing: { path: "", entries: [], error: null },
    loading: true,
    bgLoading: false,
    selected: new Set(),
    view: "list",
    zoom: 1,
  };
}

function shapeKeyOf(entries: FsEntry[], shift: boolean): string {
  if (entries.length > 1) return `multi|${shift}`;
  const first = entries[0];
  if (!first) return `empty|${shift}`;
  if (first.is_dir) {
    return /^[a-z]:\\?$/i.test(first.path) ? `drive|${shift}` : `dir|${shift}`;
  }
  const dot = first.name.lastIndexOf(".");
  const ext = dot > 0 ? first.name.slice(dot + 1).toLowerCase() : "";
  return `ext:${ext}|${shift}`;
}

function findMatchingCmdId(
  groups: ShellMenuItem[][],
  trail: string[],
  verb: string | null,
): number | null {
  if (trail.length === 0) return null;
  const [head, ...rest] = trail;
  const headLow = head.toLowerCase();
  for (const g of groups) {
    for (const item of g) {
      if (rest.length === 0) {
        if (verb && item.verb?.toLowerCase() === verb && item.cmdId !== null) {
          return item.cmdId;
        }
        if (item.label.toLowerCase() === headLow && item.cmdId !== null) {
          return item.cmdId;
        }
      } else if (item.label.toLowerCase() === headLow && item.submenu?.length) {
        const subHit = findMatchingCmdId(item.submenu, rest, verb);
        if (subHit !== null) return subHit;
      }
    }
  }
  return null;
}

interface ExactMenuCacheEntry {
  resp?: ShellContextMenuResponse;
  promise: Promise<ShellContextMenuResponse>;
  ts: number;
}

export default function App() {
  const [downloadsPath, setDownloadsPath] = useState<string>(() => getInitialPath());
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab(getInitialPath())]);
  const [activeId, setActiveId] = useState<number>(0);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeRef = useRef(active);
  activeRef.current = active;

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    groups: MenuGroup[];
  } | null>(null);
  const menuReqIdRef = useRef(0);
  const bgShellCacheRef = useRef<Map<string, ShellContextMenuResponse>>(new Map());
  const exactShellCacheRef = useRef<Map<string, ExactMenuCacheEntry>>(new Map());
  const shapeShellCacheRef = useRef<Map<string, ShellContextMenuResponse>>(new Map());

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const renameTargetRef = useRef(renameTarget);
  renameTargetRef.current = renameTarget;

  const [newItemPath, setNewItemPath] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ query: string; entries: FsEntry[] } | null>(null);
  const [isSearchingSubfolders, setIsSearchingSubfolders] = useState(false);
  const [focusAddrSignal, setFocusAddrSignal] = useState(0);
  const [hasOsClip, setHasOsClip] = useState(false);
  const [cutSet, setCutSet] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<HistoryAction[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryAction[]>([]);
  const [shellNewItems, setShellNewItems] = useState<ShellNewEntry[]>([
    { label: "Folder", ext: "", kind: { type: "empty" } },
    { label: "Text Document", ext: "txt", kind: { type: "empty" } },
  ]);

  // Live background transfer tracking for non-intrusive status bar display
  const [bgTransfer, setBgTransfer] = useState<TransferProgress | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    const unsub = onTransferProgress((p) => {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      setBgTransfer(p);
      if (p.done) {
        timer = window.setTimeout(() => {
          setBgTransfer(null);
        }, 3200);
      }
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      unsub();
    };
  }, []);

  const [showPane, setShowPane] = useState<boolean>(() => {
    try {
      return localStorage.getItem("show-pane") === "1";
    } catch {
      return false;
    }
  });
  const [paneMode, setPaneMode] = useState<"preview" | "details">(() => {
    try {
      return localStorage.getItem("pane-mode") === "details" ? "details" : "preview";
    } catch {
      return "preview";
    }
  });

  const togglePreview = useCallback(() => {
    setShowPane((prev) => {
      const next = !prev || paneMode !== "preview";
      try {
        localStorage.setItem("show-pane", next ? "1" : "0");
        localStorage.setItem("pane-mode", "preview");
      } catch {}
      setPaneMode("preview");
      return next;
    });
  }, [paneMode]);

  const toggleDetails = useCallback(() => {
    setShowPane((prev) => {
      const next = !prev || paneMode !== "details";
      try {
        localStorage.setItem("show-pane", next ? "1" : "0");
        localStorage.setItem("pane-mode", "details");
      } catch {}
      setPaneMode("details");
      return next;
    });
  }, [paneMode]);

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("explorer-sort") ?? "") as unknown;
      if (raw && typeof raw === "object") {
        const r = raw as { key?: unknown; dir?: unknown };
        if (
          (r.key === "name" || r.key === "size" || r.key === "type" || r.key === "date") &&
          (r.dir === 1 || r.dir === -1)
        ) {
          return { key: r.key, dir: r.dir };
        }
      }
    } catch {
      /* defaults */
    }
    return { key: "name", dir: 1 };
  });

  const [groupBy, setGroupBy] = useState<GroupByKey>(() => {
    try {
      const g = localStorage.getItem("explorer-groupby");
      if (g === "name" || g === "date" || g === "type" || g === "size") return g;
    } catch {
      /* ignore */
    }
    return "none";
  });

  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("show-hidden") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("explorer-sort", JSON.stringify(sort));
      localStorage.setItem("explorer-groupby", groupBy);
      localStorage.setItem("show-hidden", showHidden ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [sort, groupBy, showHidden]);

  useEffect(() => {
    api
      .getDownloadsPath()
      .then((dp) => {
        try {
          localStorage.setItem("downloads-path", dp);
        } catch {}
        setDownloadsPath(dp);
      })
      .catch(() => {});
  }, []);

  // Live folder updates: watches the active directory for external file creation/deletion/renames
  useEffect(() => {
    if (!active || active.path.startsWith("shell:") || active.path.startsWith("upnp::")) return;
    api.watchFolder(active.path).catch(() => {});
  }, [active?.path]);

  useEffect(() => {
    return onFolderChanged((changedPath) => {
      const cur = activeRef.current;
      if (!cur) return;
      const normCur = cur.path.replace(/[\\/]+$/, "").toLowerCase();
      const normChanged = changedPath.replace(/[\\/]+$/, "").toLowerCase();
      if (normCur === normChanged) {
        if (!renameTargetRef.current) {
          refreshRef.current();
        }
      }
    });
  }, []);

  // Load ShellNew entries + resolve their real 16x16 icons once on startup
  useEffect(() => {
    let alive = true;
    api
      .getShellNewItems()
      .then(async (items) => {
        if (!alive) return;
        const base: ShellNewEntry[] = [
          { label: "Folder", ext: "", kind: { type: "empty" } },
          { label: "Text Document", ext: "txt", kind: { type: "empty" } },
        ];
        const seen = new Set(["folder", "txt"]);
        const rest: ShellNewEntry[] = items.filter(
          (i) => i.ext && !seen.has(i.ext.toLowerCase()) && (seen.add(i.ext.toLowerCase()), true),
        );
        const merged = [...base, ...rest];
        setShellNewItems(merged);

        const iconReqs = merged
          .filter((e) => e.ext)
          .map((e) => ({
            key: e.ext.toLowerCase(),
            path: `a.${e.ext}`,
            isDir: false,
            ext: e.ext,
            size: 16,
            preview: false,
          }));
        if (iconReqs.length) {
          const icons = await api.getEntryIconsBatch(iconReqs).catch(() => []);
          if (!alive) return;
          const map = new Map(icons.map((r) => [r.key, r.url]));
          setShellNewItems((prev) =>
            prev.map((e) =>
              e.ext ? { ...e, iconUrl: map.get(e.ext.toLowerCase()) ?? null } : e,
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const anchorRef = useRef<string | null>(null);
  const edgeRef = useRef<string | null>(null);
  const visibleRef = useRef<FsEntry[]>([]);
  const clipRef = useRef<{ paths: string[]; mode: ClipboardMode }>({ paths: [], mode: "copy" });
  const toastTimer = useRef<number>(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const showStatus = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1200);
  }, []);

  const searchSeq = useRef(0);

  const executeSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    const cur = activeRef.current;
    if (!cur || cur.path.startsWith("shell:") || !trimmed) {
      setSearchResults(null);
      setIsSearchingSubfolders(false);
      return;
    }
    const seq = ++searchSeq.current;
    setIsSearchingSubfolders(true);
    const searchPath = cur.path;

    api
      .searchFiles(searchPath, trimmed)
      .then((entries) => {
        if (searchSeq.current === seq) {
          setSearchResults({ query: trimmed, entries });
        }
      })
      .catch((err) => {
        console.error("Search error:", err);
      })
      .finally(() => {
        if (searchSeq.current === seq) {
          setIsSearchingSubfolders(false);
        }
      });
  }, []);

  useEffect(() => {
    setSearchResults(null);
    setIsSearchingSubfolders(false);
  }, [active?.path]);

  // Live search: automatically searches current directory and subfolders as you type
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setIsSearchingSubfolders(false);
      return;
    }
    const cur = activeRef.current;
    if (!cur || cur.path.startsWith("shell:")) {
      setSearchResults(null);
      setIsSearchingSubfolders(false);
      return;
    }

    const timer = window.setTimeout(() => {
      executeSearch(q);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [searchQuery, active?.path, executeSearch]);

  const pushHistory = useCallback((entry: HistoryAction) => {
    setUndoStack((prev) => [...prev.slice(-29), entry]);
    setRedoStack([]);
  }, []);

  const refreshClipboardFlag = useCallback(() => {
    api
      .hasClipboard()
      .then(setHasOsClip)
      .catch(() => {});
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeId === 0 && tabs.length) setActiveId(tabs[0].id);
    refreshClipboardFlag();
  }, []);

  const setTab = useCallback((id: number, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t,
      ),
    );
  }, []);

  const activeNavigate = useCallback(
    (target: string, replaceCurrent = false) => {
      if (!active) return;
      anchorRef.current = null;
      edgeRef.current = null;
      setSearchQuery("");
      setSearchResults(null);
      setIsSearchingSubfolders(false);
      if (target.startsWith("upnp::")) {
        api.openPath(target.slice("upnp::".length)).catch((err) => showToast(String(err)));
        return;
      }
      if (target === "shell:Network") target = "shell:ThisPC";
      if (target.startsWith("shell:")) {
        const t = target;
        setTab(active.id, (tab) => {
          const history = replaceCurrent
            ? [...tab.history.slice(0, tab.hIndex), t]
            : [...tab.history.slice(0, tab.hIndex + 1), t];
          return {
            path: t,
            history,
            hIndex: replaceCurrent ? tab.hIndex : tab.hIndex + 1,
            selected: new Set<string>(),
          };
        });
        return;
      }
      // Drive roots must keep their trailing backslash: bare "C:" is a
      // drive-RELATIVE path on Windows (= the process's working directory,
      // i.e. the dev project folder), not the root of the drive.
      const stripped = target.replace(/\\+$/, "");
      const t = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped || "C:\\";
      setTab(active.id, (tab) => {
        const history = replaceCurrent
          ? [...tab.history.slice(0, tab.hIndex), t]
          : [...tab.history.slice(0, tab.hIndex + 1), t];
        return {
          path: t,
          history,
          hIndex: replaceCurrent ? tab.hIndex : tab.hIndex + 1,
          selected: new Set<string>(),
        };
      });
    },
    [active, setTab],
  );

  const openTab = useCallback(
    (path: string) => {
      if (path.startsWith("upnp::")) {
        api.openPath(path.slice("upnp::".length)).catch((err) => showToast(String(err)));
        return;
      }
      const t = newTab(path);
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    },
    [showToast],
  );

  const closeTab = useCallback((id: number) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) {
        const fresh = newTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      setActiveId((cur) => (cur === id ? next[Math.max(0, idx - 1)].id : cur));
      return next;
    });
  }, []);

  const closeOtherTabs = useCallback((keepId: number) => {
    setTabs((prev) => {
      const kept = prev.filter((t) => t.id === keepId);
      return kept.length ? kept : prev;
    });
    setActiveId(keepId);
  }, []);

  useEffect(() => {
    api
      .getQuickAccess()
      .then((links) => {
        const target = links.find((l) => l.name === "Downloads") ?? links[0];
        if (target && active)
          setTab(active.id, {
            path: target.path,
            history: [target.path],
            hIndex: 0,
            selected: new Set(),
          });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const reportPcLoading = useCallback((loading: boolean) => {
    const id = activeIdRef.current;
    setTabs((prev) => {
      const t = prev.find((x) => x.id === id);
      if (!t || t.bgLoading === loading) return prev;
      return prev.map((x) => (x.id === id ? { ...x, bgLoading: loading } : x));
    });
  }, []);

  const isRecycle = active?.path === "shell:RecycleBinFolder";
  const isThisPC = active?.path === "shell:ThisPC" || active?.path === "shell:Network";
  const [pcRefresh, setPcRefresh] = useState(0);

  // Live hot-plug: when a drive disappears (USB unplugged, network drive removed),
  // any tab browsing it jumps to This PC (like Explorer); when one appears, the
  // This PC view / sidebar refresh themselves via the same event.
  useEffect(
    () =>
      onDrivesChanged((letters) => {
        const present = new Set(letters.map((l) => l.toUpperCase()));
        setTabs((prev) => {
          let changed = false;
          const next = prev.map((t) => {
            const m = /^([A-Za-z]:)/.exec(t.path);
            if (!m || present.has(m[1].toUpperCase())) return t;
            changed = true;
            return {
              ...t,
              path: "shell:ThisPC",
              history: [...t.history.slice(0, t.hIndex + 1), "shell:ThisPC"],
              hIndex: t.hIndex + 1,
              selected: new Set<string>(),
            };
          });
          return changed ? next : prev;
        });
        setPcRefresh((n) => n + 1);
      }),
    [],
  );

  useEffect(() => {
    if (!isRecycle || !active) return;
    const id = active.id;
    setTab(id, { loading: true });
    invoke<{ entries: FsEntry[] }>("list_recycle_bin")
      .then((r) =>
        setTab(id, {
          loading: false,
          listing: { path: "shell:RecycleBinFolder", entries: r.entries, error: null },
        }),
      )
      .catch((e) =>
        setTab(id, {
          loading: false,
          listing: { path: "shell:RecycleBinFolder", entries: [], error: String(e) },
        }),
      );
  }, [isRecycle, active?.id, setTab]);

  useEffect(() => {
    if (!active || isThisPC || isRecycle) return;
    const id = active.id;
    let alive = true;
    setTab(id, { loading: true });
    api
      .listDir(active.path)
      .then((res) => {
        if (alive) setTab(id, { listing: res, loading: false });
      })
      .catch((e) => {
        if (alive)
          setTab(id, {
            listing: { path: active.path, entries: [], error: String(e) },
            loading: false,
          });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.path]);

  const refresh = useCallback(() => {
    if (!active) return;
    refreshClipboardFlag();
    if (active.path === "shell:ThisPC") {
      setPcRefresh((n) => n + 1);
      return;
    }
    if (active.path === "shell:RecycleBinFolder") {
      invoke<{ entries: FsEntry[] }>("list_recycle_bin")
        .then((r) =>
          setTab(active.id, {
            listing: { path: "shell:RecycleBinFolder", entries: r.entries, error: null },
          }),
        )
        .catch(() => {});
      return;
    }
    if (active.path.startsWith("shell:")) return;
    api
      .listDir(active.path)
      .then((res) => setTab(active.id, { listing: res }))
      .catch((e) =>
        setTab(active.id, { listing: { path: active.path, entries: [], error: String(e) } }),
      );
  }, [active, setTab, refreshClipboardFlag]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const onFocus = () => refreshRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const openEntry = useCallback(
    (e: FsEntry) => {
      if (!active) return;
      if (e.path.startsWith("upnp::")) {
        api.openPath(e.path.slice("upnp::".length)).catch((err) => showToast(String(err)));
        return;
      }
      if (e.is_dir) {
        setSearchQuery("");
        setSearchResults(null);
        setIsSearchingSubfolders(false);
        activeNavigate(e.path);
      } else {
        api.openPath(e.path).catch((err) => showToast(String(err)));
      }
    },
    [active, activeNavigate, showToast],
  );

  const goBack = useCallback(() => {
    if (!active || active.hIndex === 0) return;
    setSearchQuery("");
    setSearchResults(null);
    setIsSearchingSubfolders(false);
    const i = active.hIndex - 1;
    setTab(active.id, { hIndex: i, path: active.history[i], selected: new Set() });
  }, [active, setTab]);

  const goForward = useCallback(() => {
    if (!active || active.hIndex >= active.history.length - 1) return;
    setSearchQuery("");
    setSearchResults(null);
    setIsSearchingSubfolders(false);
    const i = active.hIndex + 1;
    setTab(active.id, { hIndex: i, path: active.history[i], selected: new Set() });
  }, [active, setTab]);

  const goUp = useCallback(() => {
    if (!active) return;
    setSearchQuery("");
    setSearchResults(null);
    setIsSearchingSubfolders(false);
    if (/^\\\\[^\\]+$/.test(active.path)) {
      activeNavigate("shell:ThisPC");
      return;
    }
    if (active.path.startsWith("shell:") || active.path.startsWith("\\\\")) return;
    const norm = active.path.replace(/\\+$/, "");
    if (/^[A-Z]:$/i.test(norm)) {
      activeNavigate("shell:ThisPC");
      return;
    }
    const p = parentPath(active.path);
    if (p !== active.path) activeNavigate(p);
  }, [active, activeNavigate]);

  const onSelectRange = useCallback(
    (paths: string[], additive: boolean) => {
      if (!active) return;
      anchorRef.current = paths[paths.length - 1] ?? null;
      edgeRef.current = anchorRef.current;
      setTab(active.id, (tab) => {
        const next = additive ? new Set(tab.selected) : new Set<string>();
        for (const p of paths) next.add(p);
        return { selected: next };
      });
    },
    [active, setTab],
  );

  const onSelect = useCallback(
    (pathSel: string, additive: boolean) => {
      if (!active) return;
      if (!pathSel) {
        anchorRef.current = null;
        edgeRef.current = null;
      } else if (!additive) {
        anchorRef.current = pathSel;
        edgeRef.current = pathSel;
      }
      setTab(active.id, (tab) => {
        const prev = tab.selected;
        if (!pathSel) return { selected: new Set<string>() };
        const next = additive ? new Set(prev) : new Set<string>();
        if (additive && prev.has(pathSel) && prev.size > 1) next.delete(pathSel);
        else next.add(pathSel);
        return { selected: next };
      });
    },
    [active, setTab],
  );

  const doCopy = useCallback(
    (mode: ClipboardMode) => {
      if (!active) return;
      const paths = [...active.selected];
      if (!paths.length) return;
      clipRef.current = { paths, mode };
      setHasOsClip(true);
      setCutSet(mode === "cut" ? new Set(paths) : new Set());
      api.setClipboard(paths, mode).catch((e) => showToast(String(e)));
      showToast(`${mode === "cut" ? "Cut" : "Copied"} ${paths.length} item(s)`);
    },
    [active, showToast],
  );

  const doPaste = useCallback(() => {
    if (!active || active.path.startsWith("shell:")) return;
    showStatus("Pasting…");
    api
      .paste(active.path)
      .then((res) => {
        setCutSet(new Set());
        if (clipRef.current.mode === "cut") clipRef.current = { paths: [], mode: "copy" };
        if (res && res.pairs && res.pairs.length > 0) {
          const pairs = res.pairs;
          const isCut = res.is_cut;
          pushHistory({
            label: isCut
              ? (pairs.length === 1 ? `Move "${pairs[0][0].split("\\").pop()}"` : `Move ${pairs.length} items`)
              : (pairs.length === 1 ? `Copy "${pairs[0][0].split("\\").pop()}"` : `Copy ${pairs.length} items`),
            undo: async () => {
              if (isCut) {
                for (const [src, dst] of pairs) {
                  await api.moveItem(dst, src);
                }
              } else {
                await api.deleteItems(pairs.map(([, dst]) => dst));
              }
            },
            redo: async () => {
              if (isCut) {
                for (const [src, dst] of pairs) {
                  await api.moveItem(src, dst);
                }
              } else {
                for (const [src, dst] of pairs) {
                  await api.copyItem(src, dst);
                }
              }
            },
          });
        }
        showToast("Pasted");
        refresh();
      })
      .catch((e) => showToast(String(e)));
  }, [active, refresh, showToast, showStatus, pushHistory]);

  const doUndo = useCallback(() => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((prev) => prev.slice(0, -1));
    last
      .undo()
      .then(() => {
        setRedoStack((prev) => [...prev, last]);
        showToast(`Undid ${last.label}`);
        refresh();
      })
      .catch((e) => showToast(String(e)));
  }, [undoStack, refresh, showToast]);

  const doRedo = useCallback(() => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    setRedoStack((prev) => prev.slice(0, -1));
    last
      .redo()
      .then(() => {
        setUndoStack((prev) => [...prev, last]);
        showToast(`Redid ${last.label}`);
        refresh();
      })
      .catch((e) => showToast(String(e)));
  }, [redoStack, refresh, showToast]);

  const doDropInto = useCallback(
    (targetDirPath: string, items: string[]) => {
      const dir = targetDirPath.replace(/\\+$/, "");
      showStatus(`Moving ${items.length} item(s)…`);
      api
        .moveItemsWithProgress(items, dir)
        .then((res) => {
          if (res && res.pairs && res.pairs.length > 0) {
            const pairs = res.pairs;
            pushHistory({
              label: pairs.length === 1 ? `Move "${pairs[0][0].split("\\").pop()}"` : `Move ${pairs.length} items`,
              undo: async () => {
                for (const [src, dst] of pairs) await api.moveItem(dst, src);
              },
              redo: async () => {
                for (const [src, dst] of pairs) await api.moveItem(src, dst);
              },
            });
            showToast(`Moved ${pairs.length} item(s)`);
          }
          refresh();
        })
        .catch((e) => {
          showToast(String(e));
          refresh();
        });
    },
    [refresh, showToast, showStatus, pushHistory],
  );

  const doDelete = useCallback(
    (permanent = false) => {
      if (!active) return;
      const paths = [...active.selected];
      if (!paths.length) return;
      setTab(active.id, { selected: new Set() });
      showStatus(`${permanent ? "Permanently deleting" : "Deleting"} ${paths.length} item(s)…`);
      const op = permanent ? api.deleteItemsPermanently(paths) : api.deleteItems(paths);
      op.then(() => {
        showToast(`${permanent ? "Permanently deleted" : "Deleted"} ${paths.length} item(s)`);
        if (!permanent) {
          pushHistory({
            label: paths.length === 1 ? `Delete "${paths[0].split("\\").pop()}"` : `Delete ${paths.length} items`,
            undo: async () => {
              await api.restoreItems(paths);
            },
            redo: async () => {
              await api.deleteItems(paths);
            },
          });
        }
        refresh();
      }).catch((e) => {
        showToast(String(e));
        refresh();
      });
    },
    [active, refresh, setTab, showToast, showStatus, pushHistory],
  );

  const doCancelNewItem = useCallback(
    (path: string | null) => {
      const p = path ?? newItemPath;
      if (!p) return;
      api
        .deleteItemsPermanently([p])
        .then(refresh)
        .catch(() => {});
      setNewItemPath(null);
    },
    [newItemPath, refresh],
  );

  const doRename = useCallback(
    (newName: string) => {
      const target = renameTarget;
      if (!target || !newName) {
        if (newItemPath && !newName) doCancelNewItem(target ?? newItemPath);
        setRenameTarget(null);
        return;
      }
      const wasNew = newItemPath === target;
      setNewItemPath(null);
      setRenameTarget(null);
      const oldName = target.split("\\").pop() ?? "";
      if (newName === oldName) {
        if (wasNew) {
          pushHistory({
            label: `New "${oldName}"`,
            undo: async () => {
              await api.deleteItems([target]);
            },
            redo: async () => {
              await api.restoreItems([target]);
            },
          });
        }
        return;
      }
      const parent = target.slice(0, target.lastIndexOf("\\"));
      const renamedPath = `${parent}\\${newName}`;
      api
        .renameItem(target, newName)
        .then(() => {
          if (wasNew) {
            pushHistory({
              label: `New "${newName}"`,
              undo: async () => {
                await api.deleteItems([renamedPath]);
              },
              redo: async () => {
                await api.restoreItems([renamedPath]);
              },
            });
          } else {
            pushHistory({
              label: `Rename "${oldName}" → "${newName}"`,
              undo: async () => {
                await api.renameItem(renamedPath, oldName);
              },
              redo: async () => {
                await api.renameItem(target, newName);
              },
            });
          }
          refresh();
        })
        .catch((e) => showToast(String(e)));
    },
    [renameTarget, newItemPath, doCancelNewItem, refresh, showToast, pushHistory],
  );

  const doCancelRename = useCallback(() => {
    setRenameTarget(null);
    if (newItemPath) doCancelNewItem(newItemPath);
    setNewItemPath(null);
  }, [newItemPath, doCancelNewItem]);

  const createInline = useCallback(
    (kind: "folder" | "txt") => {
      if (!active) return;
      if (active.path.startsWith("shell:")) {
        showToast("Open a folder first — nothing to create here.");
        return;
      }
      const create =
        kind === "folder"
          ? api.createFolder(active.path, "New folder")
          : api.createEmptyFile(active.path, "New Text Document.txt");
      create
        .then((path) => {
          refresh();
          setNewItemPath(path);
          setRenameTarget(path);
        })
        .catch((e) => showToast(String(e)));
    },
    [active, refresh, showToast],
  );

  const createShellNewInline = useCallback(
    (ext: string, label: string) => {
      if (!active) return;
      if (active.path.startsWith("shell:")) {
        showToast("Open a folder first — nothing to create here.");
        return;
      }
      api
        .createShellNewItem(active.path, ext, label)
        .then((path) => {
          refresh();
          setNewItemPath(path);
          setRenameTarget(path);
        })
        .catch((e) => showToast(String(e)));
    },
    [active, refresh, showToast],
  );

  const doRestore = useCallback(() => {
    if (!active || !isRecycle) return;
    const paths = [...active.selected];
    if (!paths.length) return;
    showStatus(`Restoring ${paths.length} item(s)…`);
    api
      .restoreItems(paths)
      .then(() => {
        showToast(`Restored ${paths.length} item(s)`);
        setTab(active.id, { selected: new Set() });
        refresh();
      })
      .catch((e) => {
        showToast(String(e));
        refresh();
      });
  }, [active, isRecycle, refresh, setTab, showToast, showStatus]);

  const doEmptyBin = useCallback(() => {
    if (!active) return;
    invoke<{ entries: FsEntry[] }>("list_recycle_bin")
      .then((r) => {
        const all = r.entries.map((e) => e.path).filter((p) => !p.startsWith("shell:::"));
        if (!all.length) {
          showToast("Recycle Bin is already empty");
          return;
        }
        showStatus(`Emptying Recycle Bin (${all.length} items)…`);
        api
          .deleteItemsPermanently(all)
          .then(() => {
            showToast("Recycle Bin emptied");
            refresh();
          })
          .catch((e) => showToast(String(e)));
      })
      .catch((e) => showToast(String(e)));
  }, [active, refresh, showToast, showStatus]);

  /** Convert a backend `ShellMenuItem` tree into `MenuGroup[]`, wiring native
   *  Windows Shell extensions alongside Fast Explorer's in-app actions.
   *  Supports both a resolved `sessionId` and an in-flight `Promise<ShellContextMenuResponse>`
   *  so cached shell templates render in 0ms while binding clicks to the live session. */
  const mapShellNodeRaw = useCallback(
    (
      node: ShellMenuItem,
      sessionSource: number | Promise<ShellContextMenuResponse>,
      selectedEntries: FsEntry[],
      ptX: number,
      ptY: number,
      trail: string[] = [],
    ): MenuItem[] => {
      const selectedPaths = selectedEntries.map((e) => e.path);
      const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
      const v = node.verb?.toLowerCase() ?? null;
      const nextTrail = [...trail, node.label];

      if (node.submenu && node.submenu.length > 0) {
        const subGroups: MenuGroup[] = node.submenu
          .map((g) => ({
            items: g.flatMap((child) =>
              mapShellNode(child, sessionSource, selectedEntries, ptX, ptY, nextTrail),
            ),
          }))
          .filter((g) => g.items.length > 0);
        if (!subGroups.length) return [];
        return [
          {
            label: node.label,
            iconUrl: node.icon,
            disabled: node.disabled,
            submenu: subGroups,
          },
        ];
      }

      if ((v === "open" || (node.primary && node.label.toLowerCase() === "open")) && single?.is_dir) {
        return [
          {
            label: "Open",
            iconUrl: node.icon,
            primary: true,
            action: () => openEntry(single),
          },
          {
            label: "Open in new tab",
            icon: FolderPlus,
            action: () => openTab(single.path),
          },
        ];
      }

      const cleanLabel = node.label.replace(/&/g, "").trim().toLowerCase();

      if (v === "pintohome" || cleanLabel === "pin to quick access") {
        return [
          {
            label: "Pin to Quick access",
            icon: Pin,
            iconUrl: node.icon,
            action: () => {
              const target = single ?? selectedEntries[0];
              if (!target) return;
              const name = target.name || target.path;
              api
                .pinToQuickAccess(name, target.path)
                .then(() => showToast("Pinned to Quick access"))
                .catch((e) => showToast(String(e)));
            },
          },
        ];
      }

      if (v === "unpinfromhome" || cleanLabel === "unpin from quick access") {
        return [
          {
            label: "Unpin from Quick access",
            icon: PinOff,
            iconUrl: node.icon,
            action: () => {
              const target = single ?? selectedEntries[0];
              if (!target) return;
              api
                .unpinFromQuickAccess(target.path)
                .then(() => showToast("Unpinned from Quick access"))
                .catch((e) => showToast(String(e)));
            },
          },
        ];
      }

      if (v === "cut") {
        return [
          {
            label: node.label || "Cut",
            iconUrl: node.icon,
            icon: node.icon ? undefined : Scissors,
            shortcut: "Ctrl+X",
            action: () => doCopy("cut"),
          },
        ];
      }

      if (v === "copy") {
        return [
          {
            label: node.label || "Copy",
            iconUrl: node.icon,
            icon: node.icon ? undefined : ClipboardCopy,
            shortcut: "Ctrl+C",
            action: () => doCopy("copy"),
          },
        ];
      }

      if (v === "paste") {
        return [
          {
            label: node.label || "Paste",
            iconUrl: node.icon,
            icon: node.icon ? undefined : ClipboardPaste,
            shortcut: "Ctrl+V",
            action: () => doPaste(),
          },
        ];
      }

      if (v === "delete") {
        return [
          {
            label: node.label || "Delete",
            iconUrl: node.icon,
            icon: node.icon ? undefined : Trash2Icon,
            shortcut: "Del",
            action: () => doDelete(false),
          },
        ];
      }

      if (v === "rename") {
        return [
          {
            label: node.label || "Rename",
            iconUrl: node.icon,
            icon: node.icon ? undefined : PenLine,
            shortcut: "F2",
            disabled: selectedEntries.length !== 1,
            action: () => {
              if (single) setRenameTarget(single.path);
            },
          },
        ];
      }

      if (v === "link") {
        return [
          {
            label: node.label || "Create shortcut",
            iconUrl: node.icon,
            action: () => {
              api
                .createShortcut(selectedPaths)
                .then(() => {
                  showToast("Shortcut created");
                  refresh();
                })
                .catch((e) => showToast(String(e)));
            },
          },
        ];
      }

      if (v === "properties") {
        return [
          {
            label: node.label || "Properties",
            iconUrl: node.icon,
            shortcut: "Alt+Enter",
            action: () => {
              api.showProperties(selectedPaths).catch((e) => showToast(String(e)));
            },
          },
        ];
      }

      if (node.cmdId !== null) {
        const cid = node.cmdId;
        const dirHint = active && !active.path.startsWith("shell:") ? active.path : undefined;
        return [
          {
            label: node.label,
            shortcut: node.shortcut,
            iconUrl: node.icon,
            primary: node.primary,
            disabled: node.disabled,
            action: () => {
              const runInvoke =
                typeof sessionSource === "number"
                  ? api.invokeShellContextItem(sessionSource, cid, ptX, ptY, dirHint)
                  : sessionSource.then((liveResp) => {
                      const liveCid = findMatchingCmdId(liveResp.groups, nextTrail, v) ?? cid;
                      return api.invokeShellContextItem(
                        liveResp.sessionId,
                        liveCid,
                        ptX,
                        ptY,
                        dirHint,
                      );
                    });
              runInvoke
                .then(() => {
                  window.setTimeout(() => refreshRef.current(), 350);
                  window.setTimeout(() => refreshRef.current(), 1500);
                })
                .catch((e) => showToast(String(e)));
            },
          },
        ];
      }

      return [];
    },
    [active, doCopy, doDelete, doPaste, openEntry, openTab, refresh, showToast],
  );

  /** Adds a built-in fallback glyph to shell items that provide no icon of their own. */
  const mapShellNode = useCallback(
    (...args: Parameters<typeof mapShellNodeRaw>): MenuItem[] =>
      mapShellNodeRaw(...args).map((it) =>
        it.iconUrl || it.icon ? it : { ...it, icon: fallbackMenuIcon(it.label) },
      ),
    [mapShellNodeRaw],
  );

  /** Build View / Sort by / Group by / New submenus for the folder background menu. */
  const buildViewSubmenu = useCallback((): MenuGroup[] => {
    const v = active?.view ?? "list";
    const z = active?.zoom ?? 1;
    const isPreset = (pv: "list" | "grid", pz: number) => v === pv && Math.abs(z - pz) < 0.11;
    const setPreset = (pv: "list" | "grid", pz: number) => {
      if (active) setTab(active.id, { view: pv, zoom: pz });
    };
    return [
      {
        items: [
          {
            label: "Extra large icons",
            radio: isPreset("grid", 1.8),
            action: () => setPreset("grid", 1.8),
          },
          {
            label: "Large icons",
            radio: isPreset("grid", 1.3),
            action: () => setPreset("grid", 1.3),
          },
          {
            label: "Medium icons",
            radio: isPreset("grid", 1.0),
            action: () => setPreset("grid", 1.0),
          },
          {
            label: "Small icons",
            radio: isPreset("grid", 0.75),
            action: () => setPreset("grid", 0.75),
          },
        ],
      },
      {
        items: [
          {
            label: "Details",
            radio: v === "list" && z >= 0.95,
            action: () => setPreset("list", 1.0),
          },
          {
            label: "Compact view",
            radio: v === "list" && z < 0.95,
            action: () => setPreset("list", 0.85),
          },
        ],
      },
      {
        items: [
          {
            label: "Show hidden items",
            checked: showHidden,
            action: () => setShowHidden((s) => !s),
          },
        ],
      },
    ];
  }, [active, setTab, showHidden]);

  const buildSortSubmenu = useCallback((): MenuGroup[] => {
    return [
      {
        items: [
          {
            label: "Name",
            radio: sort.key === "name",
            action: () => setSort((p) => ({ key: "name", dir: p.dir })),
          },
          {
            label: "Date modified",
            radio: sort.key === "date",
            action: () => setSort((p) => ({ key: "date", dir: p.dir })),
          },
          {
            label: "Type",
            radio: sort.key === "type",
            action: () => setSort((p) => ({ key: "type", dir: p.dir })),
          },
          {
            label: "Size",
            radio: sort.key === "size",
            action: () => setSort((p) => ({ key: "size", dir: p.dir })),
          },
        ],
      },
      {
        items: [
          {
            label: "Ascending",
            radio: sort.dir === 1,
            action: () => setSort((p) => ({ ...p, dir: 1 })),
          },
          {
            label: "Descending",
            radio: sort.dir === -1,
            action: () => setSort((p) => ({ ...p, dir: -1 })),
          },
        ],
      },
    ];
  }, [sort]);

  const buildGroupSubmenu = useCallback((): MenuGroup[] => {
    return [
      {
        items: [
          { label: "(None)", radio: groupBy === "none", action: () => setGroupBy("none") },
          { label: "Name", radio: groupBy === "name", action: () => setGroupBy("name") },
          {
            label: "Date modified",
            radio: groupBy === "date",
            action: () => setGroupBy("date"),
          },
          { label: "Type", radio: groupBy === "type", action: () => setGroupBy("type") },
          { label: "Size", radio: groupBy === "size", action: () => setGroupBy("size") },
        ],
      },
    ];
  }, [groupBy]);

  const buildNewSubmenu = useCallback((): MenuGroup[] => {
    const folderItem: MenuItem = {
      label: "Folder",
      icon: FolderPlus,
      action: () => createInline("folder"),
    };
    const restItems: MenuItem[] = shellNewItems
      .filter((e) => e.ext !== "")
      .map((entry) => ({
        label: entry.label,
        iconUrl: entry.iconUrl,
        icon: entry.iconUrl ? undefined : FileText,
        action: () => {
          if (entry.ext === "txt") createInline("txt");
          else createShellNewInline(entry.ext, entry.label);
        },
      }));
    return [{ items: [folderItem] }, { items: restItems }];
  }, [shellNewItems, createInline, createShellNewInline]);

  const fetchAndCacheShellMenu = useCallback(
    (targets: FsEntry[], shift: boolean): ExactMenuCacheEntry => {
      const targetPaths = targets.map((t) => t.path);
      if (targetPaths.some((p) => p.startsWith("upnp::"))) {
        return {
          promise: Promise.resolve({ sessionId: 0, groups: [] }),
          ts: Date.now(),
        };
      }
      const exactKey = `${targetPaths.join("\0")}|${shift}`;
      const cache = exactShellCacheRef.current;
      const existing = cache.get(exactKey);
      if (existing && Date.now() - existing.ts < 15_000) {
        // Refresh LRU order so active items stay within the backend 6-session ring buffer.
        cache.delete(exactKey);
        cache.set(exactKey, existing);
        return existing;
      }

      const promise = api
        .queryShellContextMenu(targetPaths, shift)
        .catch((): ShellContextMenuResponse => ({ sessionId: 0, groups: [] }));

      const slot: ExactMenuCacheEntry = { promise, ts: Date.now() };
      cache.set(exactKey, slot);
      while (cache.size > 4) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }

      promise.then((resp) => {
        if (resp.groups.length > 0) {
          slot.resp = resp;
          slot.ts = Date.now();
          shapeShellCacheRef.current.set(shapeKeyOf(targets, shift), resp);
          if (
            targets.length === 1 &&
            !targets[0].is_dir &&
            !shapeShellCacheRef.current.has(`anyfile|${shift}`)
          ) {
            shapeShellCacheRef.current.set(`anyfile|${shift}`, resp);
          }
        } else {
          cache.delete(exactKey);
        }
      });

      return slot;
    },
    [],
  );

  /** Warm the shell context menu on pointer hover / right-button mousedown so
   *  `contextmenu` renders 100% of shell integrations synchronously in 0ms. */
  const warmEntryMenu = useCallback(
    (entry: FsEntry, shift: boolean) => {
      if (!active || isRecycle || entry.path.startsWith("upnp::")) return;
      const selectedSet = active.selected.has(entry.path)
        ? active.selected
        : new Set([entry.path]);
      const selectedEntries = active.listing.entries.filter((en) => selectedSet.has(en.path));
      const targets = selectedEntries.length ? selectedEntries : [entry];
      fetchAndCacheShellMenu(targets, shift);
    },
    [active, isRecycle, fetchAndCacheShellMenu],
  );

  // Pre-warm folder background shell menus at startup and whenever switching folders.
  useEffect(() => {
    const warmBg = (p: string, shift: boolean, fallbackKey?: string) => {
      api
        .queryBackgroundShellMenu(p, shift)
        .then((resp) => {
          bgShellCacheRef.current.set(`${p}|${shift}`, resp);
          if (fallbackKey) bgShellCacheRef.current.set(fallbackKey, resp);
        })
        .catch(() => {});
    };
    if (!bgShellCacheRef.current.has("default|false")) {
      warmBg("C:\\", false, "default|false");
      warmBg("C:\\", true, "default|true");
    }
    if (
      active &&
      !active.path.startsWith("shell:") &&
      !bgShellCacheRef.current.has(`${active.path}|false`)
    ) {
      warmBg(active.path, false);
    }
  }, [active?.path]);

  // Pre-warm one folder + one file template as soon as initial directory entries arrive.
  useEffect(() => {
    if (!active || isRecycle || active.path.startsWith("shell:")) return;
    const entries = active.listing.entries;
    if (!entries.length) return;
    if (!shapeShellCacheRef.current.has("dir|false")) {
      const dirSample = entries.find((e) => e.is_dir);
      if (dirSample) fetchAndCacheShellMenu([dirSample], false);
    }
    if (!shapeShellCacheRef.current.has("anyfile|false")) {
      const fileSample = entries.find((e) => !e.is_dir);
      if (fileSample) fetchAndCacheShellMenu([fileSample], false);
    }
  }, [active, isRecycle, fetchAndCacheShellMenu]);

  const mapBgResponseGroups = useCallback(
    (bgResp: ShellContextMenuResponse, dirPath: string, cx: number, cy: number): MenuGroup[] => {
      return bgResp.groups
        .map((g) => ({
          items: g.map((item): MenuItem => {
            if (item.submenu && item.submenu.length > 0) {
              return {
                label: item.label,
                iconUrl: item.icon,
                disabled: item.disabled,
                submenu: item.submenu.map((sg) => ({
                  items: sg.flatMap((child) =>
                    mapShellNode(child, bgResp.sessionId, [], cx, cy),
                  ),
                })),
              };
            }
            if (item.verb === "open_terminal") {
              return {
                label: item.label,
                iconUrl: item.icon,
                icon: item.icon ? undefined : TerminalIcon,
                action: () => api.openTerminal(dirPath).catch((err) => showToast(String(err))),
              };
            }
            if (item.command) {
              const cmd = item.command;
              return {
                label: item.label,
                shortcut: item.shortcut,
                iconUrl: item.icon,
                action: () =>
                  api
                    .invokeBackgroundCommand(dirPath, cmd)
                    .catch((err) => showToast(String(err))),
              };
            }
            return (
              mapShellNode(item, bgResp.sessionId, [], cx, cy)[0] ?? {
                label: item.label,
                disabled: true,
              }
            );
          }),
        }))
        .filter((g) => g.items.length > 0);
    },
    [mapShellNode, showToast],
  );

  /** Show the Windows Explorer-style folder background right-click menu instantaneously (0ms). */
  const showBackgroundMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!active) return;
      const reqId = ++menuReqIdRef.current;
      const cx = e.clientX;
      const cy = e.clientY;
      const shift = e.shiftKey;
      const dirPath = active.path;
      const isVirtual = dirPath.startsWith("shell:");
      const lastUndo = undoStack[undoStack.length - 1];
      const lastRedo = redoStack[redoStack.length - 1];

      const makeBgGroups = (
        integrationGroups: MenuGroup[],
        canPasteNow: boolean,
      ): MenuGroup[] => {
        if (isRecycle) {
          return [
            {
              items: [
                { label: "View", submenu: buildViewSubmenu() },
                { label: "Sort by", submenu: buildSortSubmenu() },
                { label: "Refresh", action: () => refresh() },
              ],
            },
            {
              items: [
                {
                  label: "Empty Recycle Bin",
                  icon: Trash2Icon,
                  danger: true,
                  disabled: active.listing.entries.length === 0,
                  action: () => doEmptyBin(),
                },
              ],
            },
            {
              items: [
                {
                  label: "Open in new tab",
                  icon: FolderPlus,
                  action: () => openTab(dirPath),
                },
              ],
            },
          ];
        }

        if (isVirtual) {
          return [
            {
              items: [
                { label: "View", submenu: buildViewSubmenu() },
                { label: "Refresh", action: () => refresh() },
              ],
            },
            {
              items: [
                {
                  label: "Open in new tab",
                  icon: FolderPlus,
                  action: () => openTab(dirPath),
                },
              ],
            },
          ];
        }

        const pasteAndIntegrations: MenuItem[] = [
          {
            label: "Paste",
            shortcut: "Ctrl+V",
            disabled: !canPasteNow,
            action: () => doPaste(),
          },
          ...(lastUndo
            ? [
                {
                  label: `Undo ${lastUndo.label}`,
                  shortcut: "Ctrl+Z",
                  action: () => doUndo(),
                },
              ]
            : [
                {
                  label: "Undo",
                  shortcut: "Ctrl+Z",
                  disabled: true,
                  action: () => {},
                },
              ]),
          ...(lastRedo
            ? [
                {
                  label: `Redo ${lastRedo.label}`,
                  shortcut: "Ctrl+Y",
                  action: () => doRedo(),
                },
              ]
            : [
                {
                  label: "Redo",
                  shortcut: "Ctrl+Y",
                  disabled: true,
                  action: () => {},
                },
              ]),
          ...(integrationGroups[0]?.items ?? []),
        ];

        const extraComGroups = integrationGroups.slice(1);

        return [
          {
            items: [
              { label: "View", submenu: buildViewSubmenu() },
              { label: "Sort by", submenu: buildSortSubmenu() },
              { label: "Group by", submenu: buildGroupSubmenu() },
              { label: "Refresh", action: () => refresh() },
            ],
          },
          ...(!/^[A-Z]:\\?$/i.test(dirPath)
            ? [
                {
                  items: [
                    {
                      label: "Customise this folder...",
                      action: () =>
                        api
                          .showProperties([dirPath], "Customize")
                          .catch((err) => showToast(String(err))),
                    },
                  ],
                },
              ]
            : []),
          { items: pasteAndIntegrations },
          ...extraComGroups,
          {
            items: [{ label: "New", submenu: buildNewSubmenu() }],
          },
          {
            items: [
              ...(!/^[A-Z]:\\?$/i.test(dirPath)
                ? [
                    {
                      label: "Pin to Quick access",
                      icon: Pin,
                      action: () => {
                        const name = dirPath.split("\\").filter(Boolean).pop() || dirPath;
                        api
                          .pinToQuickAccess(name, dirPath)
                          .then(() => showToast("Pinned to Quick access"))
                          .catch((err) => showToast(String(err)));
                      },
                    },
                  ]
                : []),
              {
                label: "Open in new tab",
                icon: FolderPlus,
                action: () => openTab(dirPath),
              },
              {
                label: "Properties",
                shortcut: "Alt+Enter",
                action: () =>
                  api.showProperties([dirPath]).catch((err) => showToast(String(err))),
              },
            ],
          },
        ];
      };

      const canPasteInitial = hasOsClip || clipRef.current.paths.length > 0;
      const cachedBg =
        !isVirtual
          ? bgShellCacheRef.current.get(`${dirPath}|${shift}`) ??
            bgShellCacheRef.current.get(`default|${shift}`)
          : undefined;
      const initialIntegrations = cachedBg ? mapBgResponseGroups(cachedBg, dirPath, cx, cy) : [];

      setMenu({
        x: cx,
        y: cy,
        groups: makeBgGroups(initialIntegrations, canPasteInitial),
      });

      if (isVirtual) return;

      Promise.all([
        api.queryBackgroundShellMenu(dirPath, shift).catch(() => cachedBg ?? { sessionId: 0, groups: [] }),
        api.hasClipboard().catch(() => canPasteInitial),
      ]).then(([bgResp, hasClip]) => {
        if (bgResp.groups.length) {
          bgShellCacheRef.current.set(`${dirPath}|${shift}`, bgResp);
        }
        setHasOsClip(hasClip);
        if (menuReqIdRef.current !== reqId) return;

        const mappedGroups = mapBgResponseGroups(bgResp, dirPath, cx, cy);
        setMenu({
          x: cx,
          y: cy,
          groups: makeBgGroups(mappedGroups, hasClip || clipRef.current.paths.length > 0),
        });
      });
    },
    [
      active,
      isRecycle,
      undoStack,
      redoStack,
      hasOsClip,
      buildViewSubmenu,
      buildSortSubmenu,
      buildGroupSubmenu,
      buildNewSubmenu,
      refresh,
      doEmptyBin,
      openTab,
      doPaste,
      doUndo,
      doRedo,
      showToast,
      mapBgResponseGroups,
    ],
  );

  /** Show the Windows Explorer item context menu instantaneously (0ms) with all shell integrations! */
  const showEntryMenu = useCallback(
    (e: React.MouseEvent, entry: FsEntry | null) => {
      if (!entry) {
        showBackgroundMenu(e);
        return;
      }
      e.preventDefault();
      if (!active) return;

      const reqId = ++menuReqIdRef.current;
      const cx = e.clientX;
      const cy = e.clientY;
      const shift = e.shiftKey;

      const selectedSet = active.selected.has(entry.path)
        ? active.selected
        : new Set([entry.path]);
      const selectedEntries = active.listing.entries.filter((en) => selectedSet.has(en.path));
      const targets = selectedEntries.length ? selectedEntries : [entry];
      const targetPaths = targets.map((t) => t.path);

      if (isRecycle) {
        setMenu({
          x: cx,
          y: cy,
          groups: [
            {
              items: [
                {
                  label: "Restore",
                  icon: RotateCcw,
                  primary: true,
                  action: () => doRestore(),
                },
              ],
            },
            {
              items: [
                { label: "Cut", icon: Scissors, action: () => doCopy("cut") },
                {
                  label: "Delete",
                  icon: Trash2Icon,
                  danger: true,
                  action: () => doDelete(true),
                },
              ],
            },
            {
              items: [
                {
                  label: "Properties",
                  icon: Info,
                  action: () =>
                    api
                      .showProperties(targetPaths.filter((p) => !p.startsWith("shell:::")))
                      .catch(() => {}),
                },
              ],
            },
          ],
        });
        return;
      }

      const fallbackGroups: MenuGroup[] = [
        {
          items: [
            { label: "Open", primary: true, action: () => openEntry(entry) },
            ...(targets.length === 1 && entry.is_dir
              ? [
                  {
                    label: "Open in new tab",
                    icon: FolderPlus,
                    action: () => openTab(entry.path),
                  },
                  {
                    label: "Pin to Quick access",
                    icon: Pin,
                    action: () =>
                      api
                        .pinToQuickAccess(entry.name || entry.path, entry.path)
                        .then(() => showToast("Pinned to Quick access"))
                        .catch((err) => showToast(String(err))),
                  },
                ]
              : []),
            ...(!entry.is_dir && targets.length === 1
              ? [
                  {
                    label: "Open with…",
                    action: () =>
                      api.openWithDialog(entry.path).catch((err) => showToast(String(err))),
                  },
                ]
              : []),
          ],
        },
        {
          items: [
            { label: "Cut", icon: Scissors, shortcut: "Ctrl+X", action: () => doCopy("cut") },
            {
              label: "Copy",
              icon: ClipboardCopy,
              shortcut: "Ctrl+C",
              action: () => doCopy("copy"),
            },
            {
              label: "Copy as path",
              icon: LinkIcon,
              action: () => api.copyAsPath(targetPaths).catch((err) => showToast(String(err))),
            },
          ],
        },
        {
          items: [
            {
              label: "Create shortcut",
              action: () =>
                api
                  .createShortcut(targetPaths)
                  .then(() => refresh())
                  .catch((err) => showToast(String(err))),
            },
            {
              label: "Delete",
              icon: Trash2Icon,
              shortcut: "Del",
              action: () => doDelete(shift),
            },
            {
              label: "Rename",
              icon: PenLine,
              shortcut: "F2",
              disabled: targets.length !== 1,
              action: () => setRenameTarget(entry.path),
            },
          ],
        },
        {
          items: [
            {
              label: "Properties",
              shortcut: "Alt+Enter",
              action: () =>
                api.showProperties(targetPaths).catch((err) => showToast(String(err))),
            },
          ],
        },
      ];

      if (entry.path.startsWith("upnp::")) {
        const deviceUrl = entry.path.slice("upnp::".length);
        setMenu({
          x: cx,
          y: cy,
          groups: [
            {
              items: [
                {
                  label: "View device webpage",
                  primary: true,
                  action: () => api.openPath(deviceUrl).catch((err) => showToast(String(err))),
                },
                {
                  label: "Copy device URL",
                  icon: LinkIcon,
                  action: () =>
                    api
                      .copyAsPath([deviceUrl])
                      .then(() => showToast("Copied device URL"))
                      .catch((err) => showToast(String(err))),
                },
              ],
            },
          ],
        });
        return;
      }

      const buildGroupsFromShell = (
        resp: ShellContextMenuResponse,
        sessionSource: number | Promise<ShellContextMenuResponse>,
      ): MenuGroup[] => {
        const groups: MenuGroup[] = resp.groups
          .map((g) => ({
            items: g.flatMap((node) => mapShellNode(node, sessionSource, targets, cx, cy)),
          }))
          .filter((g) => g.items.length > 0);

        if (targets.length === 1 && !entry.is_dir) {
          const hasOpenWith = groups.some((g) =>
            g.items.some((i) => i.label.toLowerCase().startsWith("open with")),
          );
          if (!hasOpenWith && groups.length > 0) {
            groups[0].items.push({
              label: "Open with…",
              action: () =>
                api.openWithDialog(entry.path).catch((err) => showToast(String(err))),
            });
          }
        }

        const hasCopyPath = groups.some((g) =>
          g.items.some((i) => i.label.toLowerCase() === "copy as path"),
        );
        if (!hasCopyPath && groups.length > 1) {
          groups[1].items.push({
            label: "Copy as path",
            shortcut: "Ctrl+Shift+C",
            action: () => api.copyAsPath(targetPaths).catch((err) => showToast(String(err))),
          });
        }

        if (targets.length === 1 && entry.is_dir) {
          const hasPinOrUnpin = groups.some((g) =>
            g.items.some((i) => i.label.toLowerCase().includes("quick access")),
          );
          if (!hasPinOrUnpin && groups.length > 0) {
            groups[0].items.push({
              label: "Pin to Quick access",
              icon: Pin,
              action: () =>
                api
                  .pinToQuickAccess(entry.name || entry.path, entry.path)
                  .then(() => showToast("Pinned to Quick access"))
                  .catch((err) => showToast(String(err))),
            });
          }
        }
        return groups;
      };

      const slot = fetchAndCacheShellMenu(targets, shift);

      if (slot.resp && slot.resp.groups.length > 0) {
        setMenu({
          x: cx,
          y: cy,
          groups: buildGroupsFromShell(slot.resp, slot.resp.sessionId),
        });
        return;
      }

      const templateResp =
        shapeShellCacheRef.current.get(shapeKeyOf(targets, shift)) ??
        (targets.length === 1 && !entry.is_dir
          ? shapeShellCacheRef.current.get(`anyfile|${shift}`)
          : undefined);

      if (templateResp && templateResp.groups.length > 0) {
        setMenu({
          x: cx,
          y: cy,
          groups: buildGroupsFromShell(templateResp, slot.promise),
        });
      } else {
        setMenu({ x: cx, y: cy, groups: fallbackGroups });
      }

      slot.promise.then((resp) => {
        if (menuReqIdRef.current !== reqId) return;
        if (!resp.groups.length) return;
        setMenu({
          x: cx,
          y: cy,
          groups: buildGroupsFromShell(resp, resp.sessionId),
        });
      });
    },
    [
      active,
      isRecycle,
      showBackgroundMenu,
      doRestore,
      doCopy,
      doDelete,
      openEntry,
      openTab,
      refresh,
      showToast,
      mapShellNode,
      fetchAndCacheShellMenu,
    ],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "F3" || (e.ctrlKey && (e.key === "f" || e.key === "F"))) {
        e.preventDefault();
        e.stopPropagation();
        setSearchQuery("");
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>("[data-fast-search]");
          input?.focus();
          input?.select();
        });
        return;
      }
      if (e.key === "Escape") {
        if (searchQuery) {
          e.preventDefault();
          setSearchQuery("");
          setSearchResults(null);
          setIsSearchingSubfolders(false);
          return;
        }
      }
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key !== "Escape") return;
      }

      if (e.altKey && e.key === "Enter" && active && !active.path.startsWith("shell:")) {
        e.preventDefault();
        const targets = active.selected.size ? [...active.selected] : [active.path];
        api.showProperties(targets).catch((err) => showToast(String(err)));
      } else if (
        (e.ctrlKey && (e.key === "l" || e.key === "L")) ||
        (e.altKey && (e.key === "d" || e.key === "D")) ||
        e.key === "F4"
      ) {
        e.preventDefault();
        setFocusAddrSignal((n) => n + 1);
      } else if (e.ctrlKey && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        if (active) {
          const targets = active.selected.size ? [...active.selected] : [active.path];
          api
            .copyAsPath(targets)
            .then(() => showToast("Copied path to clipboard"))
            .catch((err) => showToast(String(err)));
        }
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        setActiveId((cur) => {
          const idx = tabs.findIndex((t) => t.id === cur);
          return tabs[(idx + 1) % tabs.length].id;
        });
      } else if (e.ctrlKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        openTab(downloadsPath || getInitialPath());
      } else if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (active) closeTab(active.id);
      } else if (e.key === "F5" || (e.ctrlKey && (e.key === "r" || e.key === "R"))) {
        e.preventDefault();
        refresh();
      } else if (e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        if (e.shiftKey) toggleDetails();
        else togglePreview();
      } else if (e.key === "F2" && active && active.selected.size === 1) {
        e.preventDefault();
        setRenameTarget([...active.selected][0]);
      } else if (
        (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) &&
        active
      ) {
        e.preventDefault();
        const firstSel = [...active.selected][0];
        const entry = firstSel
          ? active.listing.entries.find((en) => en.path === firstSel) ?? null
          : null;
        const fakeEvent = {
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: 280,
          clientY: 220,
          shiftKey: e.shiftKey,
        } as unknown as React.MouseEvent;
        showEntryMenu(fakeEvent, entry);
      } else if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        active &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const entries = visibleRef.current;
        if (!entries.length) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const scrollTo = (t: FsEntry) => {
          requestAnimationFrame(() => {
            document
              .querySelector(`[data-path="${CSS.escape(t.path)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          });
        };
        if (e.shiftKey) {
          let a = anchorRef.current
            ? entries.findIndex((en) => en.path === anchorRef.current)
            : -1;
          if (a < 0) {
            a =
              active.selected.size === 1
                ? entries.findIndex((en) => en.path === [...active.selected][0])
                : 0;
            if (a < 0) a = 0;
            anchorRef.current = entries[a].path;
          }
          const edge = edgeRef.current
            ? entries.findIndex((en) => en.path === edgeRef.current)
            : a;
          const next = Math.min(entries.length - 1, Math.max(0, (edge < 0 ? a : edge) + dir));
          edgeRef.current = entries[next].path;
          const range = entries
            .slice(Math.min(a, next), Math.max(a, next) + 1)
            .map((en) => en.path);
          setTab(active.id, { selected: new Set(range) });
          scrollTo(entries[next]);
        } else {
          const cur =
            active.selected.size === 1
              ? entries.findIndex((en) => en.path === [...active.selected][0])
              : -1;
          const next =
            e.key === "ArrowDown"
              ? Math.min(entries.length - 1, cur + 1)
              : Math.max(0, cur <= 0 ? 0 : cur - 1);
          const target = entries[cur === -1 && e.key === "ArrowUp" ? entries.length - 1 : next];
          if (target) {
            setTab(active.id, { selected: new Set([target.path]) });
            anchorRef.current = target.path;
            edgeRef.current = target.path;
            scrollTo(target);
          }
        }
      } else if (e.key === "Delete") {
        e.preventDefault();
        if (isRecycle || e.shiftKey) doDelete(true);
        else doDelete(false);
      } else if (
        e.altKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp")
      ) {
        e.preventDefault();
        if (e.key === "ArrowLeft") goBack();
        else if (e.key === "ArrowRight") goForward();
        else goUp();
      } else if (
        e.key === "Enter" &&
        active &&
        active.selected.size === 1 &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const target = active.listing.entries.find(
          (en) => en.path === [...active.selected][0],
        );
        if (target) openEntry(target);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        goUp();
      } else if (e.ctrlKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        doDelete(false);
      } else if (e.ctrlKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        if (e.shiftKey) createInline("folder");
        else if (active) openTab(active.path);
      } else if (e.key === "Home" && active && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const entries = visibleRef.current;
        const first = entries[0];
        if (!first) return;
        if (e.shiftKey && anchorRef.current) {
          const a = entries.findIndex((en) => en.path === anchorRef.current);
          const range = entries.slice(0, (a < 0 ? 0 : a) + 1).map((en) => en.path);
          edgeRef.current = first.path;
          setTab(active.id, { selected: new Set(range) });
        } else {
          setTab(active.id, { selected: new Set([first.path]) });
          anchorRef.current = first.path;
          edgeRef.current = first.path;
        }
      } else if (e.key === "End" && active && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const entries = visibleRef.current;
        const last = entries[entries.length - 1];
        if (!last) return;
        if (e.shiftKey && anchorRef.current) {
          const a = entries.findIndex((en) => en.path === anchorRef.current);
          const range = entries
            .slice(a < 0 ? entries.length - 1 : a)
            .map((en) => en.path);
          edgeRef.current = last.path;
          setTab(active.id, { selected: new Set(range) });
        } else {
          setTab(active.id, { selected: new Set([last.path]) });
          anchorRef.current = last.path;
          edgeRef.current = last.path;
        }
      } else if (e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (e.shiftKey) {
          if (k === "z") {
            e.preventDefault();
            doRedo();
          }
        } else {
          if (k === "c") doCopy("copy");
          else if (k === "x") doCopy("cut");
          else if (k === "v") doPaste();
          else if (k === "z") {
            e.preventDefault();
            doUndo();
          } else if (k === "y") {
            e.preventDefault();
            doRedo();
          } else if (k === "a" && active) {
            e.preventDefault();
            setTab(active.id, {
              selected: new Set(visibleRef.current.map((en) => en.path)),
            });
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    menu,
    tabs,
    active,
    isRecycle,
    refresh,
    doDelete,
    doCopy,
    doPaste,
    doUndo,
    doRedo,
    goBack,
    goForward,
    goUp,
    openEntry,
    openTab,
    closeTab,
    setTab,
    createInline,
    showEntryMenu,
    showToast,
  ]);

  const visibleEntries = useMemo(() => {
    if (!active) return [];
    const q = searchQuery.trim().toLowerCase();
    const isSub = Boolean(searchResults && searchResults.query.toLowerCase() === q);
    let list = isSub ? searchResults!.entries : active.listing.entries;
    if (!showHidden) list = list.filter((e) => !e.is_hidden);
    if (!isSub && q) {
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }

    if (isSub) {
      if (sort.key === "name" && sort.dir === 1) {
        return list;
      }
      const activeNorm = active.path.replace(/[\\/]+$/, "").toLowerCase();
      const isCur = (e: FsEntry) => {
        const lastSlash = Math.max(e.path.lastIndexOf("\\"), e.path.lastIndexOf("/"));
        const parent = lastSlash > 0 ? e.path.slice(0, lastSlash).replace(/[\\/]+$/, "").toLowerCase() : "";
        return parent === activeNorm;
      };

      const currentEntries = list.filter(isCur);
      const subEntries = list.filter((e) => !isCur(e));

      const dir = sort.dir;
      const byName = (a: FsEntry, b: FsEntry) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      const sortFn = (a: FsEntry, b: FsEntry) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        let r = 0;
        switch (sort.key) {
          case "size":
            r = sizeBytesOf(a.size) - sizeBytesOf(b.size) || byName(a, b);
            break;
          case "type":
            r = a.item_type.localeCompare(b.item_type) || byName(a, b);
            break;
          case "date":
            r = dateValOf(a.modified) - dateValOf(b.modified) || byName(a, b);
            break;
          default:
            r = byName(a, b);
            break;
        }
        return r * dir;
      };

      return [...currentEntries.sort(sortFn), ...subEntries.sort(sortFn)];
    }

    const dir = sort.dir;
    const byName = (a: FsEntry, b: FsEntry) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return [...list].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r = 0;
      switch (sort.key) {
        case "size":
          r = sizeBytesOf(a.size) - sizeBytesOf(b.size) || byName(a, b);
          break;
        case "type":
          r = a.item_type.localeCompare(b.item_type) || byName(a, b);
          break;
        case "date":
          r = dateValOf(a.modified) - dateValOf(b.modified) || byName(a, b);
          break;
        default:
          r = byName(a, b);
          break;
      }
      return r * dir;
    });
  }, [active, searchQuery, searchResults, showHidden, sort]);
  visibleRef.current = visibleEntries;

  const statusParts = useMemo(() => {
    const total = visibleEntries.length;
    const selCount = active?.selected.size ?? 0;
    let selBytes = 0;
    if (selCount && active) {
      for (const e of active.listing.entries) {
        if (!e.is_dir && active.selected.has(e.path)) {
          selBytes += sizeBytesOf(e.size);
        }
      }
    }
    return {
      totalLabel: `${total} item${total === 1 ? "" : "s"}`,
      selLabel: selCount
        ? `${selCount} item${selCount === 1 ? "" : "s"} selected`
        : null,
      selSizeLabel: selBytes > 0 ? formatHumanBytes(selBytes) : null,
    };
  }, [visibleEntries.length, active]);

  const selectedEntriesList = useMemo(() => {
    if (!active) return [];
    const sel = active.selected;
    return visibleEntries.filter((e) => sel.has(e.path));
  }, [active, visibleEntries]);

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 },
    );
  }, []);

  const onShiftSelect = useCallback(
    (pathSel: string, additive: boolean) => {
      if (!active) return;
      const order = visibleRef.current;
      const idx = order.findIndex((e) => e.path === pathSel);
      if (idx < 0) return;
      let a = anchorRef.current ? order.findIndex((e) => e.path === anchorRef.current) : -1;
      if (a < 0) a = 0;
      const range = order.slice(Math.min(a, idx), Math.max(a, idx) + 1).map((e) => e.path);
      edgeRef.current = pathSel;
      setTab(active.id, (tab) => {
        const next = additive ? new Set(tab.selected) : new Set<string>();
        for (const p of range) next.add(p);
        return { selected: next };
      });
    },
    [active, setTab],
  );

  if (!active) return null;

  return (
    <div className="flex h-full flex-col bg-[#191919] text-[13px]">
      <TabBar
        tabs={tabs.map((t) => ({
          id: t.id,
          path: t.path,
          loading: t.loading || t.bgLoading,
        }))}
        activeId={active.id}
        onSelect={(id) => {
          setSearchQuery("");
          setSearchResults(null);
          setIsSearchingSubfolders(false);
          setActiveId(id);
        }}
        onClose={closeTab}
        onCloseOthers={closeOtherTabs}
        onDuplicate={(p) => openTab(p)}
        onNew={() => openTab(downloadsPath || getInitialPath())}
        onContextMenu={(e, items) => {
          menuReqIdRef.current++;
          setMenu({ x: e.clientX, y: e.clientY, groups: [{ items }] });
        }}
        onDropIntoTab={doDropInto}
      />

      <Topbar
        path={active.path}
        canBack={active.hIndex > 0}
        canForward={active.hIndex < active.history.length - 1}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onRefresh={refresh}
        onNavigate={(p) => activeNavigate(p)}
        query={searchQuery}
        onQuery={setSearchQuery}
        loading={active.loading || active.bgLoading}
        onSearchSubfolders={executeSearch}
        isSearchingSubfolders={isSearchingSubfolders}
        focusAddressSignal={focusAddrSignal}
        onDropInto={doDropInto}
      />

      {/* Windows 11 Explorer full-width Command Bar */}
      <ActionBar
        currentPath={active.path}
        canRename={active.selected.size === 1}
        canDelete={active.selected.size > 0}
        hasClipboard={hasOsClip || clipRef.current.paths.length > 0}
        view={active.view}
        zoom={active.zoom}
        sortKey={sort.key}
        sortDir={sort.dir}
        groupBy={groupBy}
        showHidden={showHidden}
        shellNewItems={shellNewItems}
        showPreviewPane={showPane && paneMode === "preview"}
        showDetailsPane={showPane && paneMode === "details"}
        onTogglePreview={togglePreview}
        onToggleDetails={toggleDetails}
        onSetViewPreset={(v, z) => setTab(active.id, { view: v, zoom: z })}
        onSortKey={(k) => setSort((prev) => ({ key: k, dir: prev.dir }))}
        onSortDir={(d) => setSort((prev) => ({ ...prev, dir: d }))}
        onGroupBy={setGroupBy}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onNewFolder={() => createInline("folder")}
        onNewTextFile={() => createInline("txt")}
        onShellNewItem={createShellNewInline}
        onCut={() => doCopy("cut")}
        onCopy={() => doCopy("copy")}
        onPaste={doPaste}
        canUndo={undoStack.length > 0}
        onUndo={doUndo}
        undoLabel={undoStack[undoStack.length - 1]?.label}
        canRedo={redoStack.length > 0}
        onRedo={doRedo}
        redoLabel={redoStack[redoStack.length - 1]?.label}
        onRename={() => {
          if (active.selected.size === 1) setRenameTarget([...active.selected][0]);
        }}
        onDelete={() => doDelete(isRecycle)}
        onSelectAll={() =>
          setTab(active.id, { selected: new Set(visibleEntries.map((e) => e.path)) })
        }
        onInvertSelection={() =>
          setTab(active.id, (tab) => {
            const next = new Set<string>();
            for (const e of visibleEntries) {
              if (!tab.selected.has(e.path)) next.add(e.path);
            }
            return { selected: next };
          })
        }
        onCopyAsPath={() => {
          const targets = active.selected.size ? [...active.selected] : [active.path];
          api
            .copyAsPath(targets)
            .then(() => showToast("Copied path to clipboard"))
            .catch((e) => showToast(String(e)));
        }}
        onProperties={() => {
          const targets = active.selected.size ? [...active.selected] : [active.path];
          api.showProperties(targets).catch((e) => showToast(String(e)));
        }}
        onOpenDropdownMenu={(x, y, groups) => {
          menuReqIdRef.current++;
          setMenu({ x, y, groups });
        }}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          currentPath={active.path}
          onNavigate={(p) => activeNavigate(p)}
          onOpenNewTab={(p) => openTab(p)}
          onEmptyRecycleBin={doEmptyBin}
          onContextMenu={(e, groups) => {
            menuReqIdRef.current++;
            setMenu({ x: e.clientX, y: e.clientY, groups });
          }}
          onDropInto={doDropInto}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {isThisPC ? (
            <ThisPCView
              query={searchQuery}
              view={active.view}
              zoom={active.zoom}
              refreshSignal={pcRefresh}
              onBgLoadingChange={reportPcLoading}
              onOpen={(p) => activeNavigate(p)}
              onBackgroundMenu={showBackgroundMenu}
              onEntryMenu={showEntryMenu}
              onWarmEntryMenu={(entry, shift) => fetchAndCacheShellMenu([entry], shift)}
              onDropInto={doDropInto}
            />
          ) : (
            <FileView
              key={active.id}
              entries={visibleEntries}
              error={active.listing.error}
              loading={active.loading}
              view={active.view}
              zoom={active.zoom}
              onZoom={(d) =>
                setTab(active.id, (t) => ({
                  zoom: Math.min(2.4, Math.max(0.6, +(t.zoom + d).toFixed(2))),
                }))
              }
              selected={active.selected}
              cutPaths={cutSet}
              groupBy={groupBy}
              currentPath={active.path}
              searchQuery={searchQuery}
              isSearching={isSearchingSubfolders}
              onSelect={onSelect}
              onSelectRange={onSelectRange}
              onShiftSelect={onShiftSelect}
              sortKey={sort.key}
              sortDir={sort.dir}
              onSort={onSort}
              onOpen={openEntry}
              onContextMenu={showEntryMenu}
              onWarmContextMenu={warmEntryMenu}
              renamingPath={renameTarget}
              onRenameConfirm={doRename}
              onRenameCancel={doCancelRename}
              onDropInto={doDropInto}
            />
          )}
        </div>

        {showPane && (
          <PreviewPane
            selectedEntries={selectedEntriesList}
            currentDir={active.path}
            paneMode={paneMode}
            onSetPaneMode={setPaneMode}
            onClose={() => setShowPane(false)}
          />
        )}
      </div>

      {/* Windows Explorer Status Bar */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-[#2a2a2a] bg-[#191919] px-3 text-[12px] text-neutral-400">
        {!isThisPC && (
          <>
            <span>{statusParts.totalLabel}</span>
            {statusParts.selLabel && (
              <>
                <span className="h-3.5 w-px bg-[#363636]" />
                <span>{statusParts.selLabel}</span>
              </>
            )}
            {statusParts.selSizeLabel && (
              <span className="text-neutral-300">{statusParts.selSizeLabel}</span>
            )}
          </>
        )}
        <div className="flex-1" />

        {bgTransfer && (
          <div
            className="flex items-center gap-2 px-2.5 py-0.5 rounded bg-[#242424] border border-[#353535] cursor-pointer hover:bg-[#2c2c2c] transition-colors select-none"
            title="Click to view file operation window"
            onClick={async () => {
              try {
                const { getAllWindows } = await import("@tauri-apps/api/window");
                const wins = await getAllWindows();
                const tr = wins.find((w) => w.label === "transfer");
                if (tr) {
                  await tr.show();
                  await tr.setFocus();
                }
              } catch {}
            }}
          >
            {bgTransfer.done ? (
              <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
            ) : (
              <Loader2 size={12} className="animate-spin text-emerald-400 shrink-0" />
            )}
            <span className="text-[11.5px] text-neutral-200 font-medium">
              {bgTransfer.done
                ? "Done"
                : `${Math.round(bgTransfer.percent)}% • ${
                    bgTransfer.op_type === "delete"
                      ? "Deleting"
                      : bgTransfer.op_type === "restore"
                      ? "Restoring"
                      : bgTransfer.op_type === "move"
                      ? "Moving"
                      : "Copying"
                  }`}
            </span>
            <div className="w-14 h-1.5 rounded-full bg-[#3a3a3a] overflow-hidden">
              <div
                className="h-full bg-[#107c41] transition-all duration-150 rounded-full"
                style={{ width: `${Math.max(4, Math.min(100, Math.round(bgTransfer.percent)))}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setTab(active.id, { view: "list", zoom: 1.0 })}
            data-tooltip="Details view"
            aria-label="Details view"
            className={`flex h-5 w-6 items-center justify-center rounded transition-colors ${
              active.view === "list"
                ? "bg-[#323232] text-white"
                : "text-neutral-400 hover:bg-[#282828] hover:text-white"
            }`}
          >
            <List size={13} />
          </button>
          <button
            type="button"
            onClick={() => setTab(active.id, { view: "grid", zoom: 1.0 })}
            data-tooltip="Large icons view"
            aria-label="Large icons view"
            className={`flex h-5 w-6 items-center justify-center rounded transition-colors ${
              active.view === "grid"
                ? "bg-[#323232] text-white"
                : "text-neutral-400 hover:bg-[#282828] hover:text-white"
            }`}
          >
            <LayoutGrid size={13} />
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          groups={menu.groups}
          onClose={() => setMenu(null)}
        />
      )}

      <InstantTooltip />

      {toast && (
        <div className="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[#3a3a3a] bg-[#262626] px-4 py-1.5 text-[12.5px] text-neutral-200 shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}
