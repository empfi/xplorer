import { useEffect, useState } from "react";
import { api, onFileDialogClosed, onFileDialogDetected, type FileDialogEventData } from "../api";
import { ChevronDown, ExternalLink, Folder, FolderSymlink, Sparkles, X, Zap } from "lucide-react";

interface Props {
  activePath: string;
  tabs: { id: number; path: string }[];
  showToast: (msg: string) => void;
}

export default function FileDialogCompanion({ activePath, tabs, showToast }: Props) {
  const [dialogData, setDialogData] = useState<FileDialogEventData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);

  useEffect(() => {
    const unsubDetected = onFileDialogDetected((data) => {
      setDialogData(data);
      setDismissed(false);
    });

    const unsubClosed = onFileDialogClosed(() => {
      setDialogData(null);
      setDismissed(false);
      setTabsMenuOpen(false);
    });

    return () => {
      unsubDetected();
      unsubClosed();
    };
  }, []);

  if (!dialogData || dismissed) return null;

  const folderName =
    activePath.replace(/\\+$/, "").split("\\").filter(Boolean).pop() ?? activePath;

  const handleJump = async (target?: string) => {
    const path = target || activePath;
    try {
      const ok = await api.jumpDialogToPath(path);
      if (ok) {
        showToast(`Jumped file dialog to ${path}`);
      }
    } catch (err) {
      showToast(String(err));
    }
    setTabsMenuOpen(false);
  };

  const otherTabs = tabs
    .map((t) => t.path)
    .filter((p) => p !== activePath && !p.startsWith("shell:") && !p.startsWith("upnp::"));

  return (
    <aside
      aria-label="File dialog companion"
      className="fixed bottom-12 right-6 z-50 flex flex-col gap-1.5 rounded-xl border border-[#0078d4]/60 bg-[#1e1e1e]/95 p-3 text-neutral-200 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-2 duration-150 select-none max-w-[420px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#333] pb-2 text-[12px]">
        <div className="flex items-center gap-1.5 font-medium text-white">
          <FolderSymlink size={15} className="text-sky-400" />
          <span>File Dialog Detected</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="rounded bg-[#282828] px-1.5 py-0.5 text-[10px] text-neutral-400 font-mono">
            Ctrl+G to jump
          </span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-[#333] hover:text-white"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11px] text-neutral-400">Current folder:</span>
          <span className="truncate text-[12.5px] font-semibold text-white" title={activePath}>
            {folderName}
          </span>
        </div>

        <div className="relative flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => handleJump()}
            className="flex items-center gap-1.5 rounded-md bg-[#0078d4] hover:bg-[#0086ee] px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors"
          >
            <Zap size={12} />
            <span>Jump here</span>
          </button>

          {otherTabs.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setTabsMenuOpen((o) => !o)}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-[#383838] bg-[#2a2a2a] text-neutral-300 hover:bg-[#333] hover:text-white transition-colors"
                title="Other tabs"
              >
                <ChevronDown size={13} />
              </button>

              {tabsMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 w-64 rounded-lg border border-[#383838] bg-[#222222] p-1 shadow-2xl text-[12px] z-50">
                  <div className="px-2 py-1 text-[11px] text-neutral-400 font-medium border-b border-[#333]">
                    Jump to other open tab:
                  </div>
                  <div className="max-h-48 overflow-y-auto py-1">
                    {otherTabs.map((path) => {
                      const name =
                        path.replace(/\\+$/, "").split("\\").filter(Boolean).pop() ?? path;
                      return (
                        <button
                          key={path}
                          type="button"
                          onClick={() => handleJump(path)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-neutral-200 hover:bg-[#333] hover:text-white"
                        >
                          <Folder size={13} className="shrink-0 text-sky-400" />
                          <span className="truncate flex-1">{name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
