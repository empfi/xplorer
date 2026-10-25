import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

interface ActiveTip {
  trigger: HTMLElement;
  text: string;
  rect: DOMRect;
}

const SUPPORTS_POPOVER =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

function upgradeTitleAttr(el: HTMLElement): string | null {
  const rawTitle = el.getAttribute("title");
  if (rawTitle !== null) {
    const trimmed = rawTitle.trim();
    if (trimmed) {
      el.setAttribute("data-tooltip", trimmed);
      if (!el.hasAttribute("aria-label") && !(el.textContent ?? "").trim()) {
        el.setAttribute("aria-label", trimmed);
      }
    }
    el.removeAttribute("title");
  }
  return el.getAttribute("data-tooltip");
}

function resolveTrigger(node: EventTarget | null): { el: HTMLElement; text: string } | null {
  if (!(node instanceof Element)) return null;
  // Upgrade any ancestor [title] attributes on first contact so native OS delayed tooltips never fire.
  let cur: Element | null = node;
  while (cur instanceof HTMLElement) {
    if (cur.hasAttribute("title")) upgradeTitleAttr(cur);
    cur = cur.parentElement;
  }

  const found = node.closest("[data-tooltip]");
  if (!(found instanceof HTMLElement)) return null;
  if (found.hasAttribute("disabled") || (found as HTMLButtonElement).disabled) return null;

  const text = (found.getAttribute("data-tooltip") ?? "").trim();
  if (!text) return null;

  if (found.dataset.tooltipTruncated === "true") {
    const isTruncated =
      found.scrollWidth > found.clientWidth + 1 || found.scrollHeight > found.clientHeight + 1;
    if (!isTruncated) return null;
  }

  return { el: found, text };
}

/**
 * Global zero-delay (0ms) Windows 11 Explorer-style tooltip manager.
 * Satisfies WCAG 1.4.13 (Dismissible via Escape, Hoverable over tooltip box, Persistent).
 */
export default function InstantTooltip() {
  const tooltipId = useId();
  const tipRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveTip | null>(null);
  const [tip, setTip] = useState<ActiveTip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  activeRef.current = tip;

  useEffect(() => {
    const show = (next: ActiveTip | null) => {
      const prev = activeRef.current;
      if (prev?.trigger === next?.trigger && prev?.text === next?.text) return;
      if (prev?.trigger && prev.trigger.getAttribute("aria-describedby") === tooltipId) {
        prev.trigger.removeAttribute("aria-describedby");
      }
      if (next) {
        next.trigger.setAttribute("aria-describedby", tooltipId);
      }
      activeRef.current = next;
      setTip(next);
    };

    const onPointerOver = (e: PointerEvent) => {
      if (e.buttons !== 0) return;
      const target = e.target;
      // WCAG 1.4.13 Hoverable: moving pointer onto the tooltip itself keeps it open.
      if (target instanceof Node && tipRef.current?.contains(target)) {
        return;
      }
      const resolved = resolveTrigger(target);
      if (!resolved) {
        if (activeRef.current) show(null);
        return;
      }
      show({
        trigger: resolved.el,
        text: resolved.text,
        rect: resolved.el.getBoundingClientRect(),
      });
    };

    const onPointerOut = (e: PointerEvent) => {
      const cur = activeRef.current;
      if (!cur) return;
      const rel = e.relatedTarget;
      if (
        rel instanceof Node &&
        (cur.trigger.contains(rel) || tipRef.current?.contains(rel))
      ) {
        return;
      }
      // If moving into a nested child or sibling trigger, onPointerOver will handle it;
      // if leaving window/trigger completely, dismiss immediately.
      if (!(rel instanceof Element) || !rel.closest("[data-tooltip], [title]")) {
        show(null);
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches(":focus-visible")) return;
      const resolved = resolveTrigger(target);
      if (resolved) {
        show({
          trigger: resolved.el,
          text: resolved.text,
          rect: resolved.el.getBoundingClientRect(),
        });
      }
    };

    const onFocusOut = () => {
      if (activeRef.current) show(null);
    };

    const onDismissImmediate = () => {
      if (activeRef.current) show(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // WCAG 1.4.13 Dismissible via Escape without moving pointer or focus.
      if (e.key === "Escape" && activeRef.current) {
        show(null);
      }
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("mousedown", onDismissImmediate, true);
    document.addEventListener("contextmenu", onDismissImmediate, true);
    document.addEventListener("wheel", onDismissImmediate, { capture: true, passive: true });
    document.addEventListener("scroll", onDismissImmediate, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismissImmediate);

    return () => {
      if (activeRef.current?.trigger.getAttribute("aria-describedby") === tooltipId) {
        activeRef.current.trigger.removeAttribute("aria-describedby");
      }
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("mousedown", onDismissImmediate, true);
      document.removeEventListener("contextmenu", onDismissImmediate, true);
      document.removeEventListener("wheel", onDismissImmediate, true);
      document.removeEventListener("scroll", onDismissImmediate, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismissImmediate);
    };
  }, [tooltipId]);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    if (!tip) {
      if (SUPPORTS_POPOVER) {
        try {
          el.hidePopover();
        } catch {
          /* already hidden */
        }
      }
      return;
    }

    if (SUPPORTS_POPOVER) {
      try {
        el.showPopover();
      } catch {
        /* already open */
      }
    }

    const r = el.getBoundingClientRect();
    const tr = tip.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    const gap = 6;

    let left = tr.left + tr.width / 2 - r.width / 2;
    left = Math.max(pad, Math.min(left, vw - r.width - pad));

    let top = tr.bottom + gap;
    if (top + r.height > vh - pad) {
      top = Math.max(pad, tr.top - r.height - gap);
    }

    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [tip]);

  return (
    <div
      ref={tipRef}
      id={tooltipId}
      role="tooltip"
      {...(SUPPORTS_POPOVER ? ({ popover: "manual" } as Record<string, string>) : {})}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        right: "auto",
        bottom: "auto",
        margin: 0,
        display: tip ? "block" : "none",
      }}
      className="z-[100] max-w-[360px] rounded-[5px] border border-[#3d3d3d] bg-[#2b2b2b] px-2.5 py-1 text-[11.5px] leading-[16px] text-[#f0f0f0] shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
    >
      {tip?.text ?? ""}
    </div>
  );
}
