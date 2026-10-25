import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Drive, FsEntry, QuickLink } from "../types";
import { api, onDrivesChanged, onQuickAccessChanged } from "../api";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderPlus,
  Home,
  Image,
  Info,
  Laptop,
  Link as LinkIcon,
  Monitor,
  MonitorUp,
  Music,
  Pin,
  PinOff,
  Terminal as TerminalIcon,
  Trash2,
  Video,
} from "lucide-react";
import type { MenuGroup } from "./ContextMenu";
import EntryIcon from "./EntryIcon";

export const QUICK_ICONS: Record<string, LucideIcon> = {
  Home,
  Desktop: Laptop,
  Downloads: Download,
  Documents: FileText,
  Pictures: Image,
  Music,
  Videos: Video,
};

interface Props {
  currentPath: string;
  onNavigate: (path: string) => void;
  onOpenNewTab: (path: string) => void;
  onEmptyRecycleBin?: () => void;
  onContextMenu: (e: React.MouseEvent, groups: MenuGroup[]) => void;
  /** Move files dropped onto a Quick access folder / drive (drag & drop). */
  onDropInto?: (targetDirPath: string, items: string[]) => void;
}

export default function Sidebar({
  currentPath,
  onNavigate,
  onOpenNewTab,
  onEmptyRecycleBin,
  onContextMenu,
  onDropInto,
}: Props) {
  const [quick, setQuick] = useState<QuickLink[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [quickOpen, setQuickOpen] = useState(true);
  const [pcOpen, setPcOpen] = useState(true);
  // Real Windows Terminal icon for "Open in Terminal" entries (null until loaded).
  const [terminalIcon, setTerminalIcon] = useState<string | null>(null);
  useEffect(() => {
    api.getTerminalIcon().then(setTerminalIcon).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    api.getQuickAccess().then(setQuick).catch(() => setQuick([]));
    api
      .getDrives()
      .then((list) => {
        setDrives(list);
        for (const d of list) {
          api
            .getDriveDetails(d.path)
            .then((det) => {
              setDrives((prev) =>
                prev.map((x) => (x.path === det.path ? { ...x, ...det } : x)),
              );
            })
            .catch(() => {});
        }
      })
      .catch(() => setDrives([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Live hot-plug: refresh the drive list the moment a drive appears/disappears.
  useEffect(() => onDrivesChanged(() => reload()), [reload]);
  // Live quick access: refresh when pins are added/removed/reordered from anywhere in the app.
  useEffect(() => onQuickAccessChanged(setQuick), []);

  const curNorm = currentPath.toLowerCase().replace(/[\\/]+$/, "");

  const bestMatch = useMemo(() => {
    let best: string | null = null;
    for (const q of quick) {
      const link = q.path.toLowerCase().replace(/[\\/]+$/, "");
      if (curNorm === link || (link.length > 3 && curNorm.startsWith(link + "\\"))) {
        if (best === null || link.length > best.length) best = link;
      }
    }
    return best;
  }, [quick, curNorm]);

  const active = useCallback(
    (p: string) => {
      const norm = p.toLowerCase().replace(/[\\/]+$/, "");
      if (norm === curNorm) return true;
      if (bestMatch === null) {
        // Highlight drive if inside that drive and not matching a quick access folder
        if (/^[a-z]:$/i.test(norm) && curNorm.startsWith(norm + "\\")) return true;
        return false;
      }
      return norm === bestMatch;
    },
    [bestMatch, curNorm],
  );

  const savePins = (links: QuickLink[]) => {
    setQuick(links);
    api.setQuickAccess(links).catch(() => {});
  };

  const pinFolder = (name: string, path: string) => {
    if (quick.some((q) => q.path.toLowerCase() === path.toLowerCase())) return;
    api.pinToQuickAccess(name, path).then(setQuick).catch(() => {});
  };

  const unpin = (path: string) => {
    api.unpinFromQuickAccess(path).then(setQuick).catch(() => {});
  };

  const linkMenu = (q: QuickLink): MenuGroup[] => [
    {
      items: [
        { label: "Open", primary: true, action: () => onNavigate(q.path) },
        { label: "Open in new tab", icon: FolderPlus, action: () => onOpenNewTab(q.path) },
      ],
    },
    {
      items: [
        {
          label: "Unpin from Quick access",
          icon: PinOff,
          action: () => unpin(q.path),
        },
        ...(!q.path.startsWith("shell:") && !q.path.startsWith("\\\\")
          ? [
              {
                label: "Open in Terminal",
                icon: terminalIcon ? undefined : TerminalIcon,
                iconUrl: terminalIcon,
                action: () => api.openTerminal(q.path).catch(() => {}),
              },
              {
                label: "Copy as path",
                icon: LinkIcon,
                action: () => api.copyAsPath([q.path]).catch(() => {}),
              },
            ]
          : []),
      ],
    },
    ...(!q.path.startsWith("shell:")
      ? [
          {
            items: [
              {
                label: "Properties",
                icon: Info,
                action: () => api.showProperties([q.path]).catch(() => {}),
              },
            ],
          },
        ]
      : []),
  ];

  const driveMenu = (d: Drive): MenuGroup[] => [
    {
      items: [
        { label: "Open", primary: true, action: () => onNavigate(d.path) },
        { label: "Open in new tab", icon: FolderPlus, action: () => onOpenNewTab(d.path) },
        {
          label: "Pin to Quick access",
          icon: Pin,
          disabled: quick.some((q) => q.path.toLowerCase() === d.path.toLowerCase()),
          action: () => pinFolder(d.label ? `${d.label} (${d.name})` : d.name, d.path),
        },
      ],
    },
    {
      items: [
        {
          label: "Open in Terminal",
          icon: terminalIcon ? undefined : TerminalIcon,
                iconUrl: terminalIcon,
          action: () => api.openTerminal(d.path).catch(() => {}),
        },
        {
          label: "Properties",
          icon: Info,
          action: () => api.showProperties([d.path]).catch(() => {}),
        },
      ],
    },
  ];

  // --- Drag to reorder quick-access items ---
  const draggedRef = useRef<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);

  const onDragStartLink = (path: string) => (ev: React.DragEvent) => {
    draggedRef.current = path;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("application/x-quick-link", path);
  };

  const isFileDrag = (ev: React.DragEvent) =>
    Array.from(ev.dataTransfer.types).includes("application/x-file-paths") ||
    Array.from(ev.dataTransfer.types).includes("Files");

  const dropFileItems = (ev: React.DragEvent): string[] => {
    try {
      const arr = JSON.parse(ev.dataTransfer.getData("application/x-file-paths")) as string[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  const onDragOverLink = (path: string) => (ev: React.DragEvent) => {
    if (isFileDrag(ev)) {
      if (!onDropInto) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      setOverPath(path);
      return;
    }
    if (!draggedRef.current) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    setOverPath(path);
  };

  const onDropLink = (path: string) => (ev: React.DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const isFile = isFileDrag(ev);
    const from = draggedRef.current;
    draggedRef.current = null;
    setOverPath(null);
    if (isFile) {
      if (!onDropInto || path === "shell:RecycleBinFolder") return;
      const items = dropFileItems(ev);
      if (items.length) onDropInto(path, items);
      return;
    }
    if (!from || from === path) return;
    const fromIdx = quick.findIndex((q) => q.path === from);
    const toIdx = quick.findIndex((q) => q.path === path);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...quick];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    savePins(next);
  };

  const endDrag = () => {
    draggedRef.current = null;
    setOverPath(null);
  };

  const bgMenu = (): MenuGroup[] => {
    const cur = currentPath.replace(/\\+$/, "");
    const realDir = !currentPath.startsWith("shell:") && !currentPath.startsWith("\\\\");
    return [
      {
        items: [
          ...(realDir
            ? [
                {
                  label: "Open in Terminal",
                  icon: terminalIcon ? undefined : TerminalIcon,
                iconUrl: terminalIcon,
                  action: () => api.openTerminal(cur).catch(() => {}),
                },
              ]
            : []),
          {
            label: "Pin current folder to Quick access",
            icon: Pin,
            action: () => {
              const name = cur.split("\\").filter(Boolean).pop() ?? cur;
              pinFolder(name, cur);
            },
            disabled:
              !realDir || quick.some((q) => q.path.toLowerCase() === cur.toLowerCase()),
          },
        ],
      },
    ];
  };

  const itemCls = (p: string, indent = false) =>
    `relative mx-1.5 mb-0.5 flex w-[calc(100%-0.75rem)] items-center gap-2.5 rounded-md ${
      indent ? "pl-6 pr-2" : "px-2.5"
    } py-1.5 text-left text-[12.5px] transition-colors hover:bg-[#2a2a2a] ${
      active(p) ? "bg-[#2d2d2d] text-white" : "text-neutral-300"
    }`;

  return (
    <aside
      className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-[#2a2a2a] bg-[#191919] py-2"
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, bgMenu());
      }}
    >
      {/* Quick access collapsible section */}
      <div>
        <button
          type="button"
          onClick={() => setQuickOpen((o) => !o)}
          className="mx-1.5 mb-0.5 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-medium text-neutral-400 hover:bg-[#262626] hover:text-neutral-200"
        >
          {quickOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>Quick access</span>
        </button>
        {quickOpen &&
          quick.map((q) => {
            const isOver = overPath === q.path;
            const entry: FsEntry = {
              name: q.name,
              path: q.path,
              is_dir: true,
              is_hidden: false,
              size: "",
              item_type: "File folder",
              modified: "",
            };
            return (
              <div
                key={q.path}
                data-drop-path={q.path}
                draggable
                onDragStart={onDragStartLink(q.path)}
                onDragOver={onDragOverLink(q.path)}
                onDragLeave={() => setOverPath((p) => (p === q.path ? null : p))}
                onDrop={onDropLink(q.path)}
                onDragEnd={endDrag}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(e, linkMenu(q));
                }}
              >
                <button
                  type="button"
                  data-tooltip={q.path}
                  className={`${itemCls(q.path, true)} ${
                    isOver
                      ? draggedRef.current
                        ? "border-t-2 border-[#0078d4]"
                        : "ring-2 ring-[#0078d4]"
                      : "border-t-2 border-transparent"
                  }`}
                  onClick={() => onNavigate(q.path)}
                >
                  <EntryIcon entry={entry} size={16} perPath className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{q.name}</span>
                  <Pin size={11} className="shrink-0 rotate-45 text-neutral-500 opacity-70" />
                </button>
              </div>
            );
          })}
      </div>

      {/* This PC + expandable drives list (like Windows Explorer Navigation Pane) */}
      <div className="mt-2 border-t border-[#292929] pt-2">
        <div className="mx-1.5 mb-0.5 flex items-center">
          <button
            type="button"
            onClick={() => setPcOpen((o) => !o)}
            className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-[#2a2a2a] hover:text-white"
            data-tooltip={pcOpen ? "Collapse This PC" : "Expand This PC"}
            aria-label={pcOpen ? "Collapse This PC" : "Expand This PC"}
          >
            {pcOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <button
            type="button"
            onClick={() => onNavigate("shell:ThisPC")}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, [
                {
                  items: [
                    { label: "Open", primary: true, action: () => onNavigate("shell:ThisPC") },
                    {
                      label: "Open in new tab",
                      icon: FolderPlus,
                      action: () => onOpenNewTab("shell:ThisPC"),
                    },
                  ],
                },
              ]);
            }}
            className={`relative flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[#2a2a2a] ${
              active("shell:ThisPC") ? "bg-[#2d2d2d] text-white" : "text-neutral-200"
            }`}
          >
            <EntryIcon
              entry={{
                name: "This PC",
                path: "shell:ThisPC",
                is_dir: true,
                is_hidden: false,
                size: "",
                item_type: "Folder",
                modified: "",
              }}
              size={16}
              perPath
              className="shrink-0"
            />
            <span className="truncate">This PC</span>
          </button>
        </div>

        {pcOpen &&
          drives.map((d) => {
            const label = d.label ? `${d.label} (${d.name})` : `Local Disk (${d.name})`;
            const entry: FsEntry = {
              name: label,
              path: d.path,
              is_dir: true,
              is_hidden: false,
              size: "",
              item_type: "Drive",
              modified: "",
            };
            const isOver = overPath === d.path;
            return (
              <div
                key={d.path}
                data-drop-path={d.path}
                onDragOver={onDragOverLink(d.path)}
                onDragLeave={() => setOverPath((p) => (p === d.path ? null : p))}
                onDrop={onDropLink(d.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(e, driveMenu(d));
                }}
              >
                <button
                  type="button"
                  onClick={() => onNavigate(d.path)}
                  data-tooltip={`${label}${d.total ? ` - ${d.free} free of ${d.total}` : ""}`}
                  className={`${itemCls(d.path, true)} ${
                    isOver ? "ring-2 ring-[#0078d4]" : ""
                  }`}
                >
                  <EntryIcon entry={entry} size={16} perPath className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate py-0.5 leading-normal">{label}</span>
                </button>
              </div>
            );
          })}
      </div>

      {/* Recycle Bin pinned to bottom */}
      <div className="mt-auto border-t border-[#292929] pt-1.5">
        <button
          type="button"
          onClick={() => onNavigate("shell:RecycleBinFolder")}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e, [
              {
                items: [
                  {
                    label: "Open",
                    primary: true,
                    action: () => onNavigate("shell:RecycleBinFolder"),
                  },
                  {
                    label: "Open in new tab",
                    icon: FolderPlus,
                    action: () => onOpenNewTab("shell:RecycleBinFolder"),
                  },
                ],
              },
              ...(onEmptyRecycleBin
                ? [
                    {
                      items: [
                        {
                          label: "Empty Recycle Bin",
                          icon: Trash2,
                          danger: true,
                          action: () => onEmptyRecycleBin(),
                        },
                      ],
                    },
                  ]
                : []),
            ]);
          }}
          className={itemCls("shell:RecycleBinFolder")}
        >
          <EntryIcon
            entry={{
              name: "Recycle Bin",
              path: "shell:RecycleBinFolder",
              is_dir: true,
              is_hidden: false,
              size: "",
              item_type: "Folder",
              modified: "",
            }}
            size={16}
            perPath
            className="shrink-0"
          />
          <span className="truncate">Recycle Bin</span>
        </button>
      </div>
    </aside>
  );
}
