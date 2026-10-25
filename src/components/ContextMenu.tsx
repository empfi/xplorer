import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  /** 16x16 PNG data URL from Windows Shell / Registry */
  iconUrl?: string | null;
  /** Right-aligned keyboard shortcut hint (e.g. "Ctrl+Z") */
  shortcut?: string | null;
  /** Checkmark in the left icon gutter */
  checked?: boolean;
  /** Radio dot in the left icon gutter */
  radio?: boolean;
  action?: () => void;
  /** Nested cascading submenu groups */
  submenu?: MenuGroup[];
  disabled?: boolean;
  danger?: boolean;
  /** Explorer-style bold primary action (e.g. "Open", "Play") */
  primary?: boolean;
}

/** A group of items rendered between separators, like Explorer's menu. */
export interface MenuGroup {
  items: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  groups: MenuGroup[];
  onClose: () => void;
}

/** Toolbar button that opened the currently shown dropdown (toggle-to-close support). */
export const menuOpener: { el: Element | null } = { el: null };

export default function ContextMenu({ x, y, groups, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      // Pressing the very button that opened this menu (Sort / View / …) must
      // only CLOSE it. Swallow the click that follows this mousedown so the
      // button's own onClick doesn't instantly reopen the menu. Other buttons
      // still open their own menu in one click.
      if (
        e.type === "mousedown" &&
        menuOpener.el &&
        target instanceof Node &&
        menuOpener.el.contains(target)
      ) {
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 600);
      }
      menuOpener.el = null;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        menuOpener.el = null;
        onClose();
      }
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const nonEmpty = groups.filter((g) => g.items.length > 0);

  return (
    <div ref={rootRef} onContextMenu={(e) => e.preventDefault()}>
      <MenuPanel
        anchor={{ kind: "point", x, y }}
        groups={nonEmpty}
        onClose={onClose}
      />
    </div>
  );
}

type Anchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: DOMRect };

function MenuPanel({
  anchor,
  groups,
  onClose,
}: {
  anchor: Anchor;
  groups: MenuGroup[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.kind === "point" ? anchor.x : anchor.rect.right - 2,
    top: anchor.kind === "point" ? anchor.y : anchor.rect.top - 4,
  });
  const [hoveredSub, setHoveredSub] = useState<{
    key: string;
    rect: DOMRect;
    groups: MenuGroup[];
  } | null>(null);
  const closeSubTimerRef = useRef<number>(0);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;

    let left = 0;
    let top = 0;
    if (anchor.kind === "point") {
      left = anchor.x + r.width > vw - pad ? Math.max(pad, anchor.x - r.width) : anchor.x;
      top = anchor.y + r.height > vh - pad ? Math.max(pad, vh - r.height - pad) : anchor.y;
    } else {
      const pr = anchor.rect;
      left = pr.right - 2 + r.width > vw - pad ? Math.max(pad, pr.left - r.width + 2) : pr.right - 2;
      top = pr.top - 4 + r.height > vh - pad ? Math.max(pad, vh - r.height - pad) : Math.max(pad, pr.top - 4);
    }
    setPos({ left, top });
  }, [anchor, groups]);

  useEffect(() => () => window.clearTimeout(closeSubTimerRef.current), []);

  return (
    <>
      <div
        ref={panelRef}
        style={{ left: pos.left, top: pos.top }}
        className="fixed z-50 max-h-[calc(100vh-12px)] min-w-[248px] max-w-[340px] overflow-y-auto rounded-[7px] border border-[#3c3c3c] bg-[#2b2b2b] py-1 shadow-[0_10px_28px_rgba(0,0,0,0.65)]"
      >
        {groups.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "my-1 border-t border-[#3d3d3d] pt-1" : ""}>
            {group.items.map((item, ii) => {
              const key = `${gi}:${ii}:${item.label}`;
              const hasSub = !!(item.submenu && item.submenu.some((g) => g.items.length > 0));
              const isSubOpen = hoveredSub?.key === key;
              return (
                <div key={key} className="px-1">
                  <button
                    type="button"
                    disabled={item.disabled}
                    onMouseEnter={(ev) => {
                      window.clearTimeout(closeSubTimerRef.current);
                      if (hasSub && !item.disabled) {
                        const br = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        setHoveredSub({
                          key,
                          rect: br,
                          groups: item.submenu!.filter((g) => g.items.length > 0),
                        });
                      } else if (hoveredSub) {
                        closeSubTimerRef.current = window.setTimeout(() => {
                          setHoveredSub(null);
                        }, 35);
                      }
                    }}
                    onClick={(ev) => {
                      if (item.disabled) return;
                      if (hasSub) {
                        const br = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        setHoveredSub({
                          key,
                          rect: br,
                          groups: item.submenu!.filter((g) => g.items.length > 0),
                        });
                        return;
                      }
                      item.action?.();
                      onClose();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-[4px] px-2.5 py-[5px] text-left text-[12.5px] leading-[18px] ${
                      item.disabled
                        ? "cursor-default text-neutral-500"
                        : item.danger
                          ? "text-red-400 hover:bg-[#90272a]/40"
                          : isSubOpen
                            ? "bg-[#3d3d3d] text-white"
                            : item.primary
                              ? "font-semibold text-white hover:bg-[#3d3d3d]"
                              : "text-[#eaeaea] hover:bg-[#3d3d3d]"
                    }`}
                  >
                    <span className="flex h-4 w-[18px] shrink-0 items-center justify-center">
                      {item.radio ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-white" />
                      ) : item.checked ? (
                        <Check size={14} strokeWidth={2.5} className="text-white" />
                      ) : item.iconUrl ? (
                        <img
                          src={item.iconUrl}
                          alt=""
                          width={16}
                          height={16}
                          draggable={false}
                          className={`h-4 w-4 object-contain ${item.disabled ? "opacity-40" : ""}`}
                        />
                      ) : item.icon ? (
                        <item.icon
                          size={15}
                          className={`shrink-0 ${item.danger ? "text-red-400" : "text-neutral-300"}`}
                        />
                      ) : null}
                    </span>

                    <span className="min-w-0 flex-1 truncate">{item.label}</span>

                    {hasSub ? (
                      <ChevronRight size={14} className="ml-4 shrink-0 text-neutral-400" />
                    ) : item.shortcut ? (
                      <span className="ml-5 shrink-0 text-[11.5px] text-neutral-400">
                        {item.shortcut}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {hoveredSub && (
        <div
          onMouseEnter={() => window.clearTimeout(closeSubTimerRef.current)}
        >
          <MenuPanel
            anchor={{ kind: "rect", rect: hoveredSub.rect }}
            groups={hoveredSub.groups}
            onClose={onClose}
          />
        </div>
      )}
    </>
  );
}
