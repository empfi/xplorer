import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Plus,
  Square,
  X,
  Minus,
  Loader2,
} from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import EntryIcon from "./EntryIcon";

const VIRTUAL_LABELS: Record<string, string> = {
  "shell:ThisPC": "This PC",
  "shell:Network": "Network",
  "shell:RecycleBinFolder": "Recycle Bin",
};

function labelOf(path: string): string {
  if (VIRTUAL_LABELS[path]) return VIRTUAL_LABELS[path];
  const clean = path.replace(/\\+$/, "");
  const parts = clean.split("\\");
  if (parts.length === 1 || /^[A-Z]:$/i.test(clean)) return `Local Disk (${clean || "C:"})`;
  return parts[parts.length - 1] || clean;
}

interface Props {
  tabs: { id: number; path: string; loading?: boolean }[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onCloseOthers?: (id: number) => void;
  onDuplicate?: (path: string) => void;
  onNew: () => void;
  onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
  /** Drop files onto a background tab = move into that tab's folder. */
  onDropIntoTab?: (targetDirPath: string, items: string[]) => void;
}

export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onDuplicate,
  onNew,
  onContextMenu,
  onDropIntoTab,
}: Props) {
  const [dragOverTab, setDragOverTab] = useState<number | null>(null);
  const [maximized, setMaximized] = useState(false);
  const win =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
      ? getCurrentWindow()
      : null;

  useEffect(() => {
    if (!win) return;
    let alive = true;
    const sync = () =>
      win.isMaximized().then((m) => {
        if (alive) setMaximized(m);
      });
    sync();
    const un = win.onResized(sync);
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [win]);

  const control =
    "flex h-full w-11 items-center justify-center text-neutral-300 transition-colors hover:bg-[#2d2d2d] hover:text-white";
  const closeCtl =
    "flex h-full w-11 items-center justify-center text-neutral-300 transition-colors hover:bg-[#c42b1c] hover:text-white";

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-stretch bg-[#0c0c0c] pt-1.5"
    >
      <div data-tauri-drag-region className="w-2" />

      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-hidden"
      >
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          const label = labelOf(t.path);
          return (
            <div
              key={t.id}
              data-drop-path={t.path}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(t.id);
              }}
              onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, [
                  {
                    label: "Duplicate tab",
                    action: () => onDuplicate?.(t.path),
                  },
                  {
                    label: "New tab",
                    shortcut: "Ctrl+T",
                    action: () => onNew(),
                  },
                  {
                    label: "Close tab",
                    shortcut: "Ctrl+W",
                    action: () => onClose(t.id),
                  },
                  {
                    label: "Close other tabs",
                    disabled: tabs.length <= 1,
                    action: () => onCloseOthers?.(t.id),
                  },
                ]);
              }}
              onDragOver={(ev) => {
                const types = Array.from(ev.dataTransfer.types);
                if (!types.includes("application/x-file-paths") && !types.includes("Files")) return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setDragOverTab(t.id);
                if (!isActive) onSelect(t.id);
              }}
              onDragLeave={() => setDragOverTab((p) => (p === t.id ? null : p))}
              onDrop={(ev) => {
                ev.preventDefault();
                setDragOverTab(null);
                if (isActive || !onDropIntoTab) return;
                try {
                  const arr = JSON.parse(
                    ev.dataTransfer.getData("application/x-file-paths"),
                  ) as string[];
                  if (Array.isArray(arr) && arr.length) onDropIntoTab(t.path, arr);
                } catch {
                  /* ignore */
                }
              }}
              data-tooltip={t.path}
              className={`group flex h-full max-w-[235px] min-w-[120px] shrink cursor-default items-center gap-2 rounded-t-lg px-3 text-[12.5px] transition-colors ${
                isActive
                  ? "bg-[#191919] text-white"
                  : dragOverTab === t.id
                    ? "bg-[#323232] text-white ring-1 ring-inset ring-[#0078d4]"
                    : "bg-transparent text-neutral-400 hover:bg-[#1a1a1a] hover:text-neutral-200"
              }`}
            >
              {t.loading ? (
                <Loader2 size={14} className="shrink-0 animate-spin text-neutral-300" />
              ) : (
                <EntryIcon
                  entry={{
                    name: label,
                    path: t.path,
                    is_dir: true,
                    is_hidden: false,
                    size: "",
                    item_type: "File folder",
                    modified: "",
                  }}
                  size={16}
                  perPath
                  className="shrink-0"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                data-tooltip="Close tab (Ctrl+W)"
                aria-label="Close tab"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-opacity hover:bg-[#333333] hover:text-white ${
                  isActive ? "opacity-80" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <X size={12.5} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          data-tooltip="New tab (Ctrl+T)"
          aria-label="New tab"
          className="mx-1 flex h-7 w-7 self-center items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-[#242424] hover:text-white"
        >
          <Plus size={15} />
        </button>
      </div>

      {win && (
        <div className="-mt-1.5 flex items-stretch">
          <button
            type="button"
            className={control}
            onClick={() => win.minimize()}
            data-tooltip="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className={control}
            onClick={() => win.toggleMaximize()}
            data-tooltip={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore" : "Maximize"}
          >
            <Square size={11.5} strokeWidth={maximized ? 1.5 : 2} />
          </button>
          <button
            type="button"
            className={closeCtl}
            onClick={() => win.close()}
            data-tooltip="Close"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
