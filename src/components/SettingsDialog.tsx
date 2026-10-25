import { useEffect, useState } from "react";
import { api } from "../api";
import {
  Check,
  CheckCircle2,
  ExternalLink,
  FolderSync,
  Keyboard,
  Layers,
  Monitor,
  Settings,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  showToast: (msg: string) => void;
}

export default function SettingsDialog({ open, onClose, showToast }: Props) {
  const [isDefault, setIsDefault] = useState(false);
  const [winEEnabled, setWinEEnabled] = useState(false);
  const [loadingDefault, setLoadingDefault] = useState(false);
  const [loadingWinE, setLoadingWinE] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    api
      .isDefaultFileManager()
      .then(setIsDefault)
      .catch((err) => console.error("isDefaultFileManager error:", err));
    api
      .isWinEInterceptionEnabled()
      .then(setWinEEnabled)
      .catch((err) => console.error("isWinEInterceptionEnabled error:", err));
  }, [open]);

  if (!open) return null;

  const toggleDefault = async () => {
    setLoadingDefault(true);
    try {
      if (isDefault) {
        await api.unsetAsDefaultFileManager();
        setIsDefault(false);
        showToast("Restored native Windows Explorer as default.");
      } else {
        await api.setAsDefaultFileManager();
        setIsDefault(true);
        showToast("Xplorer set as default file manager for folders & drives.");
      }
    } catch (err) {
      showToast(String(err));
    } finally {
      setLoadingDefault(false);
    }
  };

  const toggleWinE = async () => {
    setLoadingWinE(true);
    const next = !winEEnabled;
    try {
      await api.setWinEInterceptionEnabled(next);
      setWinEEnabled(next);
      showToast(
        next
          ? "Win + E shortcut redirected to Xplorer."
          : "Win + E shortcut reset to default Windows behavior.",
      );
    } catch (err) {
      showToast(String(err));
    } finally {
      setLoadingWinE(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4 select-none"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[560px] flex-col rounded-xl border border-[#383838] bg-[#1e1e1e] shadow-2xl text-neutral-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex h-12 items-center justify-between border-b border-[#2e2e2e] px-4 bg-[#232323]">
          <div className="flex items-center gap-2 font-medium text-white text-[13.5px]">
            <Settings size={16} className="text-sky-400" />
            <span>Settings</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-[#333] hover:text-white transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col gap-5 p-5 max-h-[75vh] overflow-y-auto text-[12.5px]">
          {/* Windows Integration Section */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-white font-semibold text-[13px]">
              <Monitor size={15} className="text-sky-400" />
              <span>Windows Explorer Replacement</span>
            </div>

            {/* Default File Manager Card */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-[#333] bg-[#191919] p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">Default File Manager</span>
                    {isDefault ? (
                      <span className="flex items-center gap-1 rounded bg-emerald-950/80 px-2 py-0.5 text-[11px] font-medium text-emerald-300 border border-emerald-800">
                        <CheckCircle2 size={11} /> Default
                      </span>
                    ) : (
                      <span className="rounded bg-[#2a2a2a] px-2 py-0.5 text-[11px] text-neutral-400">
                        Not Default
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] text-neutral-400 leading-relaxed">
                    Automatically opens Xplorer when clicking folders on your Desktop, drives, or
                    inside third-party applications.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={loadingDefault}
                  onClick={toggleDefault}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    isDefault
                      ? "bg-[#2d2d2d] text-neutral-300 hover:bg-[#383838] hover:text-white border border-[#404040]"
                      : "bg-[#0078d4] text-white hover:bg-[#0086ee] shadow-sm"
                  } disabled:opacity-50`}
                >
                  {loadingDefault
                    ? "Updating..."
                    : isDefault
                    ? "Restore Explorer"
                    : "Set as Default"}
                </button>
              </div>
            </div>

            {/* Win + E Interception Card */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-[#333] bg-[#191919] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">Global Win + E Shortcut</span>
                    {winEEnabled && (
                      <span className="flex items-center gap-1 rounded bg-sky-950/80 px-2 py-0.5 text-[11px] font-medium text-sky-300 border border-sky-800">
                        <Zap size={11} /> Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] text-neutral-400 leading-relaxed">
                    Pressing <kbd className="rounded bg-[#2a2a2a] px-1 py-0.5 font-mono text-neutral-200 text-[10.5px]">Win+E</kbd> brings
                    Xplorer to the front and opens a new tab instead of native Explorer.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={loadingWinE}
                  onClick={toggleWinE}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    winEEnabled ? "bg-[#0078d4]" : "bg-[#333333]"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      winEEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Single Instance Window Card */}
            <div className="flex items-center justify-between rounded-lg border border-[#333] bg-[#191919] p-3.5">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Layers size={14} className="text-neutral-400" />
                  <span className="font-semibold text-white">Single-Instance Window</span>
                  <span className="rounded bg-[#2a2a2a] px-2 py-0.5 text-[10.5px] text-emerald-400 font-medium">
                    Always On
                  </span>
                </div>
                <p className="text-[11.5px] text-neutral-400 leading-relaxed">
                  External folders open directly as new tabs inside your current Xplorer window,
                  avoiding clutter.
                </p>
              </div>
            </div>
          </div>

          {/* Quick Shortcuts Section */}
          <div className="flex flex-col gap-2.5 pt-2 border-t border-[#2e2e2e]">
            <div className="flex items-center gap-2 text-white font-semibold text-[13px]">
              <Keyboard size={15} className="text-sky-400" />
              <span>Key Shortcuts</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11.5px]">
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">New tab</span>
                <kbd className="font-mono text-neutral-400">Ctrl+T</kbd>
              </div>
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">Close tab</span>
                <kbd className="font-mono text-neutral-400">Ctrl+W</kbd>
              </div>
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">Toggle Details pane</span>
                <kbd className="font-mono text-neutral-400">Alt+P</kbd>
              </div>
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">Focus Address bar</span>
                <kbd className="font-mono text-neutral-400">Alt+D / F4</kbd>
              </div>
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">Search folder</span>
                <kbd className="font-mono text-neutral-400">Ctrl+F / F3</kbd>
              </div>
              <div className="flex items-center justify-between rounded bg-[#191919] p-2 border border-[#2a2a2a]">
                <span className="text-neutral-300">Rename selected</span>
                <kbd className="font-mono text-neutral-400">F2</kbd>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#2e2e2e] bg-[#232323] px-5 py-3 text-[11.5px] text-neutral-400">
          <span>Xplorer v0.1.0 • Windows 11 Fluent Explorer</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-[#333] hover:bg-[#3d3d3d] px-4 py-1.5 font-medium text-white transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
