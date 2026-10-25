import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Eye,
  FileText,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  Redo2,
  Scissors,
  Settings,
  Trash2,
  Undo2,
} from "lucide-react";
import type { GroupByKey, SortKey } from "../types";
import { menuOpener, type MenuGroup } from "./ContextMenu";

export interface ShellNewEntry {
  label: string;
  ext: string;
  kind: { type: "empty" | "template" | "command" };
  iconUrl?: string | null;
}

export interface ActionBarProps {
  currentPath: string;
  canRename: boolean;
  canDelete: boolean;
  hasClipboard: boolean;
  view: "list" | "grid";
  zoom: number;
  sortKey: SortKey;
  sortDir: 1 | -1;
  groupBy: GroupByKey;
  showHidden: boolean;
  shellNewItems: ShellNewEntry[];
  onSetViewPreset: (view: "list" | "grid", zoom: number) => void;
  onSortKey: (key: SortKey) => void;
  onSortDir: (dir: 1 | -1) => void;
  onGroupBy: (key: GroupByKey) => void;
  onToggleHidden: () => void;
  onNewFolder: () => void;
  onNewTextFile: () => void;
  onShellNewItem: (ext: string, label: string) => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  onCopyAsPath: () => void;
  onProperties: () => void;
  canUndo?: boolean;
  onUndo?: () => void;
  undoLabel?: string;
  canRedo?: boolean;
  onRedo?: () => void;
  redoLabel?: string;
  onOpenDropdownMenu: (x: number, y: number, groups: MenuGroup[]) => void;
  showPane?: boolean;
  onTogglePane?: () => void;
  onOpenSettings?: () => void;
}

export default function ActionBar(p: ActionBarProps) {
  const [newOpen, setNewOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const viewBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [newPos, setNewPos] = useState<{ left: number; top: number } | null>(null);

  const isVirtual = p.currentPath.startsWith("shell:");

  useEffect(() => {
    if (!newOpen) return;
    const close = (ev: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(ev.target as Node)) {
        setNewOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [newOpen]);

  const btn =
    "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-neutral-200 transition-colors hover:bg-[#323232] hover:text-white disabled:cursor-default disabled:text-neutral-600 disabled:hover:bg-transparent";
  const iconBtn =
    "flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-[#323232] hover:text-white disabled:cursor-default disabled:text-neutral-600 disabled:hover:bg-transparent";

  const openDropdownAt = (el: HTMLElement | null, groups: MenuGroup[]) => {
    if (!el) return;
    setNewOpen(false);
    menuOpener.el = el;
    const r = el.getBoundingClientRect();
    p.onOpenDropdownMenu(r.left, r.bottom + 4, groups);
  };

  const sortMenuGroups = (): MenuGroup[] => [
    {
      items: [
        { label: "Name", radio: p.sortKey === "name", action: () => p.onSortKey("name") },
        {
          label: "Date modified",
          radio: p.sortKey === "date",
          action: () => p.onSortKey("date"),
        },
        { label: "Type", radio: p.sortKey === "type", action: () => p.onSortKey("type") },
        { label: "Size", radio: p.sortKey === "size", action: () => p.onSortKey("size") },
      ],
    },
    {
      items: [
        { label: "Ascending", radio: p.sortDir === 1, action: () => p.onSortDir(1) },
        { label: "Descending", radio: p.sortDir === -1, action: () => p.onSortDir(-1) },
      ],
    },
    {
      items: [
        {
          label: "Group by",
          submenu: [
            {
              items: [
                {
                  label: "(None)",
                  radio: p.groupBy === "none",
                  action: () => p.onGroupBy("none"),
                },
                {
                  label: "Name",
                  radio: p.groupBy === "name",
                  action: () => p.onGroupBy("name"),
                },
                {
                  label: "Date modified",
                  radio: p.groupBy === "date",
                  action: () => p.onGroupBy("date"),
                },
                {
                  label: "Type",
                  radio: p.groupBy === "type",
                  action: () => p.onGroupBy("type"),
                },
                {
                  label: "Size",
                  radio: p.groupBy === "size",
                  action: () => p.onGroupBy("size"),
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const isPreset = (v: "list" | "grid", z: number) =>
    p.view === v && Math.abs(p.zoom - z) < 0.11;

  const viewMenuGroups = (): MenuGroup[] => [
    {
      items: [
        {
          label: "Extra large icons",
          radio: isPreset("grid", 1.8),
          action: () => p.onSetViewPreset("grid", 1.8),
        },
        {
          label: "Large icons",
          radio: isPreset("grid", 1.3),
          action: () => p.onSetViewPreset("grid", 1.3),
        },
        {
          label: "Medium icons",
          radio: isPreset("grid", 1.0),
          action: () => p.onSetViewPreset("grid", 1.0),
        },
        {
          label: "Small icons",
          radio: isPreset("grid", 0.75),
          action: () => p.onSetViewPreset("grid", 0.75),
        },
      ],
    },
    {
      items: [
        {
          label: "Details",
          radio: p.view === "list" && p.zoom >= 0.95,
          action: () => p.onSetViewPreset("list", 1.0),
        },
        {
          label: "Compact view",
          radio: p.view === "list" && p.zoom < 0.95,
          action: () => p.onSetViewPreset("list", 0.85),
        },
      ],
    },
    {
      items: [
        {
          label: "Hidden items",
          checked: p.showHidden,
          action: () => p.onToggleHidden(),
        },
      ],
    },
    {
      items: [
        {
          label: "Details pane",
          shortcut: "Alt+P",
          checked: !!p.showPane,
          action: () => p.onTogglePane?.(),
        },
      ],
    },
  ];

  const moreMenuGroups = (): MenuGroup[] => [
    {
      items: [
        ...(p.onUndo
          ? [
              {
                label: p.undoLabel ? `Undo ${p.undoLabel}` : "Undo",
                shortcut: "Ctrl+Z",
                disabled: !p.canUndo,
                action: () => p.onUndo?.(),
              },
            ]
          : []),
        ...(p.onRedo
          ? [
              {
                label: p.redoLabel ? `Redo ${p.redoLabel}` : "Redo",
                shortcut: "Ctrl+Y",
                disabled: !p.canRedo,
                action: () => p.onRedo?.(),
              },
            ]
          : []),
        {
          label: "Select all",
          shortcut: "Ctrl+A",
          disabled: isVirtual && p.currentPath !== "shell:RecycleBinFolder",
          action: () => p.onSelectAll(),
        },
        {
          label: "Invert selection",
          disabled: isVirtual && p.currentPath !== "shell:RecycleBinFolder",
          action: () => p.onInvertSelection(),
        },
      ],
    },
    {
      items: [
        {
          label: "Copy as path",
          shortcut: "Ctrl+Shift+C",
          disabled: !p.canDelete && isVirtual,
          action: () => p.onCopyAsPath(),
        },
        {
          label: "Properties",
          shortcut: "Alt+Enter",
          disabled: isVirtual,
          action: () => p.onProperties(),
        },
      ],
    },
    {
      items: [
        {
          label: "Settings",
          icon: Settings,
          action: () => p.onOpenSettings?.(),
        },
      ],
    },
  ];

  return (
    <div
      ref={barRef}
      className="relative flex items-center gap-0.5 overflow-x-auto overflow-y-hidden border-b border-[#2a2a2a] bg-[#1c1c1c] px-2.5 py-1"
    >
      {/* + New dropdown */}
      <div className="relative">
        <button
          ref={newBtnRef}
          type="button"
          disabled={isVirtual}
          className={btn}
          onClick={() => {
            if (newOpen) {
              setNewOpen(false);
              return;
            }
            const r = newBtnRef.current?.getBoundingClientRect();
            if (r) setNewPos({ left: r.left, top: r.bottom + 4 });
            setNewOpen(true);
          }}
        >
          <span className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border border-neutral-300 text-white">
            <Plus size={11} strokeWidth={2.5} />
          </span>
          <span className="shrink-0">New</span>
          <ChevronDown size={12} className="text-neutral-400" />
        </button>

        {newOpen && newPos && (
          <div
            className="fixed z-40 max-h-[70vh] min-w-[235px] overflow-y-auto rounded-[7px] border border-[#3c3c3c] bg-[#2b2b2b] p-1 shadow-[0_10px_28px_rgba(0,0,0,0.65)]"
            style={{
              left: Math.min(newPos.left, window.innerWidth - 250),
              top: Math.min(newPos.top, window.innerHeight - 360),
            }}
          >
            {p.shellNewItems.map((entry, idx) =>
              entry.ext === "" ? (
                <div key="folder" className="mb-1 border-b border-[#3d3d3d] pb-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-[4px] px-2.5 py-[5px] text-left text-[12.5px] text-[#eaeaea] hover:bg-[#3d3d3d]"
                    onClick={() => {
                      setNewOpen(false);
                      p.onNewFolder();
                    }}
                  >
                    <FolderPlus size={15} className="shrink-0 text-white" />
                    <span>Folder</span>
                  </button>
                </div>
              ) : (
                <button
                  key={`${entry.ext}:${idx}`}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-[4px] px-2.5 py-[5px] text-left text-[12.5px] text-[#eaeaea] hover:bg-[#3d3d3d]"
                  onClick={() => {
                    setNewOpen(false);
                    if (entry.ext === "txt") p.onNewTextFile();
                    else p.onShellNewItem(entry.ext, entry.label);
                  }}
                >
                  {entry.iconUrl ? (
                    <img
                      src={entry.iconUrl}
                      alt=""
                      width={16}
                      height={16}
                      className="h-4 w-4 shrink-0 object-contain"
                    />
                  ) : (
                    <FileText size={15} className="shrink-0 text-neutral-300" />
                  )}
                  <span className="truncate">{entry.label}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>

      <div className="mx-1.5 h-5 w-px bg-[#333333]" />

      {/* Cut / Copy / Paste / Rename / Delete */}
      <button
        type="button"
        className={iconBtn}
        onClick={p.onCut}
        data-tooltip="Cut (Ctrl+X)"
        aria-label="Cut"
        disabled={!p.canDelete}
      >
        <Scissors size={15} />
      </button>
      <button
        type="button"
        className={iconBtn}
        onClick={p.onCopy}
        data-tooltip="Copy (Ctrl+C)"
        aria-label="Copy"
        disabled={!p.canDelete}
      >
        <Copy size={15} />
      </button>
      <button
        type="button"
        className={iconBtn}
        onClick={p.onPaste}
        data-tooltip="Paste (Ctrl+V)"
        aria-label="Paste"
        disabled={!p.hasClipboard || isVirtual}
      >
        <ClipboardPaste size={15} />
      </button>
      <button
        type="button"
        className={iconBtn}
        onClick={p.onRename}
        data-tooltip="Rename (F2)"
        aria-label="Rename"
        disabled={!p.canRename}
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        className={iconBtn}
        onClick={p.onDelete}
        data-tooltip="Delete (Del)"
        aria-label="Delete"
        disabled={!p.canDelete}
      >
        <Trash2 size={15} />
      </button>

      {/* Undo & Redo */}
      {p.onUndo && (
        <button
          type="button"
          className={iconBtn}
          onClick={p.onUndo}
          data-tooltip={p.undoLabel ? `Undo ${p.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)"}
          aria-label="Undo"
          disabled={!p.canUndo}
        >
          <Undo2 size={15} />
        </button>
      )}
      {p.onRedo && (
        <button
          type="button"
          className={iconBtn}
          onClick={p.onRedo}
          data-tooltip={p.redoLabel ? `Redo ${p.redoLabel} (Ctrl+Y)` : "Redo (Ctrl+Y)"}
          aria-label="Redo"
          disabled={!p.canRedo}
        >
          <Redo2 size={15} />
        </button>
      )}

      <div className="mx-1.5 h-5 w-px bg-[#333333]" />

      {/* Sort dropdown */}
      <button
        ref={sortBtnRef}
        type="button"
        disabled={isVirtual && p.currentPath !== "shell:RecycleBinFolder"}
        className={btn}
        data-tooltip="Sort and group options"
        onClick={() => openDropdownAt(sortBtnRef.current, sortMenuGroups())}
      >
        <ArrowUpDown size={14} className="text-neutral-300" />
        <span>Sort</span>
        <ChevronDown size={12} className="text-neutral-400" />
      </button>

      {/* View dropdown */}
      <button
        ref={viewBtnRef}
        type="button"
        className={btn}
        data-tooltip="Layout and view options"
        onClick={() => openDropdownAt(viewBtnRef.current, viewMenuGroups())}
      >
        {p.view === "list" ? (
          <List size={15} className="text-neutral-300" />
        ) : (
          <LayoutGrid size={15} className="text-neutral-300" />
        )}
        <span>View</span>
        <ChevronDown size={12} className="text-neutral-400" />
      </button>

      <div className="mx-1 h-5 w-px bg-[#333333]" />

      {/* More (...) */}
      <button
        ref={moreBtnRef}
        type="button"
        className={iconBtn}
        data-tooltip="See more"
        aria-label="See more"
        onClick={() => openDropdownAt(moreBtnRef.current, moreMenuGroups())}
      >
        <MoreHorizontal size={16} />
      </button>

      {/* Right side: Details pane toggle */}
      <div className="ml-auto flex items-center">
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
            p.showPane
              ? "bg-[#333333] text-sky-400 border border-[#404040]"
              : "text-neutral-300 hover:bg-[#282828] hover:text-white"
          }`}
          data-tooltip="Details pane (Alt+P)"
          aria-label="Details pane"
          onClick={p.onTogglePane}
        >
          <PanelRight size={15} />
          <span>Details</span>
        </button>
      </div>
    </div>
  );
}
