declare global {
  interface Window {
    __XPLORER_DRAGGED_FILES__?: string[];
  }
}

export function setGlobalDragPayload(ev: React.DragEvent, paths: string[]) {
  window.__XPLORER_DRAGGED_FILES__ = paths;
  ev.dataTransfer.effectAllowed = "copyMove";
  try {
    ev.dataTransfer.setData("application/x-file-paths", JSON.stringify(paths));
    ev.dataTransfer.setData("text/plain", paths.join("\r\n"));
  } catch (err) {
    console.error("setData failed:", err);
  }
}

export function clearGlobalDragPayload() {
  window.__XPLORER_DRAGGED_FILES__ = undefined;
}

export function acceptsFileDrop(ev: React.DragEvent): boolean {
  if (typeof window !== "undefined" && window.__XPLORER_DRAGGED_FILES__?.length) {
    return true;
  }
  const types = Array.from(ev.dataTransfer?.types || []);
  return (
    types.includes("application/x-file-paths") ||
    types.includes("Files") ||
    types.includes("text/plain")
  );
}

export function extractDropItems(ev: React.DragEvent): string[] {
  // 1. In-memory drag payload (100% reliable within Xplorer session)
  if (
    typeof window !== "undefined" &&
    window.__XPLORER_DRAGGED_FILES__ &&
    window.__XPLORER_DRAGGED_FILES__.length > 0
  ) {
    return [...window.__XPLORER_DRAGGED_FILES__];
  }

  // 2. Custom MIME type application/x-file-paths
  try {
    const raw = ev.dataTransfer.getData("application/x-file-paths");
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch {}

  // 3. Plain text paths (e.g. copied/dragged path lines)
  try {
    const text = ev.dataTransfer.getData("text/plain");
    if (text) {
      const lines = text
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2 && (s.includes(":\\") || s.startsWith("\\\\")));
      if (lines.length) return lines;
    }
  } catch {}

  // 4. Native OS files (dragged from Windows Explorer, Desktop, or other apps)
  const files = Array.from(ev.dataTransfer.files ?? []);
  if (files.length > 0) {
    const paths = files
      .map((f) => (f as any).path as string)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) return paths;
  }

  return [];
}

if (typeof window !== "undefined") {
  window.addEventListener("dragend", () => {
    window.__XPLORER_DRAGGED_FILES__ = undefined;
  });
  window.addEventListener("drop", () => {
    setTimeout(() => {
      window.__XPLORER_DRAGGED_FILES__ = undefined;
    }, 150);
  });
  // Prevent the forbidden "X" cursor anywhere inside the app during drag:
  window.addEventListener(
    "dragover",
    (ev) => {
      ev.preventDefault();
      try {
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      } catch {}
    },
    true,
  );
  window.addEventListener(
    "dragenter",
    (ev) => {
      ev.preventDefault();
      try {
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      } catch {}
    },
    true,
  );
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawShortcutArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(x, y + size - 14, 14, 14, 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#0078d4";
  ctx.beginPath();
  ctx.moveTo(x + 10, y + size - 11);
  ctx.lineTo(x + 5.5, y + size - 11);
  ctx.lineTo(x + 7.5, y + size - 9);
  ctx.lineTo(x + 4, y + size - 5.5);
  ctx.lineTo(x + 5.5, y + size - 4);
  ctx.lineTo(x + 9, y + size - 7.5);
  ctx.lineTo(x + 11, y + size - 5.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDefaultDocIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  isDir: boolean,
) {
  ctx.save();
  if (isDir) {
    ctx.fillStyle = "#f5ba42";
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w * 0.45, h * 0.2, [3, 3, 0, 0]);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x, y + h * 0.18, w, h * 0.8, 3);
    ctx.fill();
  } else {
    // Document with folded corner
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#b0b0b0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 2);
    ctx.lineTo(x + w - 14, y + 2);
    ctx.lineTo(x + w - 4, y + 12);
    ctx.lineTo(x + w - 4, y + h - 2);
    ctx.lineTo(x + 6, y + h - 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Folded corner triangle
    ctx.fillStyle = "#d0d0d0";
    ctx.beginPath();
    ctx.moveTo(x + w - 14, y + 2);
    ctx.lineTo(x + w - 14, y + 12);
    ctx.lineTo(x + w - 4, y + 12);
    ctx.closePath();
    ctx.fill();

    // Document text lines
    ctx.strokeStyle = "#b0b0b0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 12, y + 18);
    ctx.lineTo(x + w - 14, y + 18);
    ctx.moveTo(x + 12, y + 24);
    ctx.lineTo(x + w - 14, y + 24);
    ctx.moveTo(x + 12, y + 30);
    ctx.lineTo(x + w - 20, y + 30);
    ctx.stroke();
  }
  ctx.restore();
}

export async function generateDragImage(
  items: string[],
  iconResolver: (path: string) => Promise<string | undefined> | string | undefined,
  isShortcutResolver?: (path: string) => boolean,
): Promise<string> {
  const count = items.length;
  if (count <= 1) {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    const path = items[0] || "";
    const isDir = !path.split(/[\\/]/).pop()?.includes(".");
    const isShortcut = isShortcutResolver?.(path) || path.toLowerCase().endsWith(".lnk");
    const iconUrl = await Promise.resolve(iconResolver(path));
    let img: HTMLImageElement | null = null;
    if (iconUrl) {
      img = await loadImage(iconUrl);
    }
    if (img) {
      ctx.drawImage(img, 0, 0, 48, 48);
    } else {
      drawDefaultDocIcon(ctx, 4, 4, 40, 40, isDir);
    }
    if (isShortcut) {
      drawShortcutArrow(ctx, 0, 0, 48);
    }
    return canvas.toDataURL("image/png");
  }

  const canvas = document.createElement("canvas");
  canvas.width = 76;
  canvas.height = 76;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const numCards = Math.min(count, 3);
  const cardSize = 44;
  const offsets = [
    { x: 2, y: 2 },
    { x: 10, y: 8 },
    { x: 18, y: 14 },
  ];

  for (let i = 0; i < numCards; i++) {
    const { x, y } = offsets[i];
    const path = items[i] || items[0];
    const isDir = !path.split(/[\\/]/).pop()?.includes(".");
    const isShortcut = isShortcutResolver?.(path) || path.toLowerCase().endsWith(".lnk");
    const iconUrl = await Promise.resolve(iconResolver(path));
    let img: HTMLImageElement | null = null;
    if (iconUrl) {
      img = await loadImage(iconUrl);
    }

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = 5;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    if (img) {
      ctx.drawImage(img, x, y, cardSize, cardSize);
    } else {
      drawDefaultDocIcon(ctx, x, y, cardSize, cardSize, isDir);
    }
    if (isShortcut) {
      drawShortcutArrow(ctx, x, y, cardSize);
    }
    ctx.restore();
  }

  const badgeText = count > 99 ? "99+" : String(count);
  const badgeX = 58;
  const badgeY = 16;
  const badgeR = 11;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;

  ctx.beginPath();
  ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
  ctx.fillStyle = "#0078d4";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  ctx.font = "bold 10.5px Segoe UI, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(badgeText, badgeX, badgeY + 0.5);
  ctx.restore();

  return canvas.toDataURL("image/png");
}
