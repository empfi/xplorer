import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export interface DeleteErrorInfo {
  message: string;
  paths: string[];
  permanent: boolean;
}

interface Props {
  error: DeleteErrorInfo | null;
  onRetry: () => void;
  onCancel: () => void;
}

export default function DeleteErrorDialog({ error, onRetry, onCancel }: Props) {
  useEffect(() => {
    if (!error) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onRetry();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [error, onRetry, onCancel]);

  if (!error) return null;

  const firstPath = error.paths[0] || "";
  const isMultiple = error.paths.length > 1;
  const isFolder = error.message.toLowerCase().includes("folder") || !firstPath.includes(".");
  const title = isMultiple
    ? "Cannot Delete Items"
    : isFolder
    ? "Cannot Delete Folder"
    : "Cannot Delete File";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm select-none"
      onClick={onCancel}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-xl border border-[#3e3e3e] bg-[#222222] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-white tracking-tight leading-tight">
              {title}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-neutral-300 break-words whitespace-pre-wrap">
              {error.message}
            </p>
            <p className="mt-2.5 text-[11.5px] text-neutral-400">
              Close the program or file and select <strong className="text-neutral-200">Try Again</strong>.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            className="rounded-md border border-[#404040] bg-[#2b2b2b] px-3.5 py-1.5 text-[13px] text-neutral-200 hover:bg-[#383838] hover:text-white transition-colors"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            className="rounded-md bg-[#0078d4] px-4 py-1.5 text-[13px] font-medium text-white shadow-sm hover:bg-[#1987dc] active:bg-[#006cc1] transition-colors"
            onClick={onRetry}
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  );
}
