import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  initial: string;
  filenameOnly?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export default function RenameDialog({ title, initial, filenameOnly, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (filenameOnly) {
      const dot = initial.lastIndexOf(".");
      const ext = initial.lastIndexOf("\\");
      const end = dot > 0 && dot > ext ? dot : initial.length;
      inputRef.current?.setSelectionRange(0, end);
    } else {
      inputRef.current?.select();
    }
  }, []);

  const confirm = () => {
    const v = value.trim();
    if (v && v.replace(/[\\/:*?"<>|]/g, "") === v) onConfirm(v);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-80 rounded-xl border border-[#3a3a3a] bg-[#252525] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-medium text-neutral-200">{title}</div>
        <input
          ref={inputRef}
          className="allow-select mb-4 w-full rounded-md border border-[#434343] bg-[#1d1d1d] px-3 py-2 text-[13px] text-neutral-200 outline-none focus:border-[#0078d4]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            className="rounded-md px-3 py-1.5 text-[13px] text-neutral-300 hover:bg-[#383838]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-[#0078d4] px-3 py-1.5 text-[13px] text-white hover:bg-[#1987dc]"
            onClick={confirm}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
