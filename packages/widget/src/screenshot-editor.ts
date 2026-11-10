/**
 * Screenshot editor — mark up the capture before it is sent.
 *
 * Loaded on demand (dynamic import from the annotator, a chunk of its own):
 * hosts that never open it never download it.
 *
 * Tools: a freehand pen, an arrow, a highlight rectangle (all in the accent
 * colour), and a redaction rectangle that pixelates the area. Every shape is
 * drawn into the image's own pixels, and the result is exported as a new
 * JPEG: the redacted pixels are gone from the file sent, not covered by a
 * layer a reviewer could remove.
 *
 * Pointer events drive mouse, pen and touch alike (`touch-action: none` on
 * the canvas). The keyboard drives the same tools: with the canvas focused,
 * the arrow keys move a crosshair (Shift for bigger steps), Enter or Space
 * starts a shape at it and ends it at the next press; Escape drops a shape
 * in progress, then closes the editor. Ctrl/⌘+Z undoes.
 *
 * Lives outside the Shadow DOM, like the popup it opens from, and inherits
 * the page's `dir`: the toolbar is a flex row, so it mirrors in RTL.
 */

import type { TFunction, Translations } from "./i18n/index.js";
import type { ThemeColors } from "./styles/theme.js";
import type { SurfaceKit } from "./surface-kit.js";

export type EditorTool = "pen" | "arrow" | "rect" | "blur";

export interface Point {
  x: number;
  y: number;
}

/** One mark on the image, in image pixels. Pen: every point; the others: start and end. */
export interface Shape {
  tool: EditorTool;
  points: Point[];
}

const TOOLS: ReadonlyArray<[EditorTool, keyof Translations]> = [
  ["pen", "editor.pen"],
  ["arrow", "editor.arrow"],
  ["rect", "editor.rect"],
  ["blur", "editor.blur"],
];

/** JPEG quality of the exported image — the capture's own. */
const EXPORT_QUALITY = 0.85;

/** The rectangle two points span, with a positive width and height. */
export function spanRect(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * Side of a redaction block, in image pixels: coarse enough that no text
 * survives (a line of body text is ~16 px at 1×), scaled with the image.
 */
export function redactionBlock(imageWidth: number): number {
  return Math.max(12, Math.round(imageWidth / 60));
}

/** A shape begun at `point`: a pen stroke grows from it, the others span from it to the pointer. */
function startShape(tool: EditorTool, point: Point): Shape {
  return { tool, points: tool === "pen" ? [point] : [point, point] };
}

/** Whether a shape is worth keeping — not a click that drew nothing. */
export function isMeaningful(shape: Shape): boolean {
  const [first, last] = [shape.points[0], shape.points[shape.points.length - 1]];
  if (!first || !last) return false;
  if (shape.tool === "pen") return shape.points.length > 1;
  const { w, h } = spanRect(first, last);
  return shape.tool === "arrow" ? Math.hypot(w, h) >= 4 : w >= 3 && h >= 3;
}

/**
 * Replace a region of `ctx` with its own average over `block`-sized cells:
 * draw it shrunk (the browser averages the pixels), then back up without
 * smoothing. The original pixels are overwritten.
 */
export function pixelate(ctx: CanvasRenderingContext2D, area: ReturnType<typeof spanRect>, block: number): void {
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(area.w));
  const h = Math.min(ctx.canvas.height - y, Math.ceil(area.h));
  if (w <= 0 || h <= 0) return;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const smallCtx = small.getContext("2d");
  if (!smallCtx) {
    // No way to average: black it out rather than leave it readable.
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
    return;
  }
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

/** Draw one shape onto `ctx` (the image already painted under it). */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, color: string): void {
  const first = shape.points[0];
  const last = shape.points[shape.points.length - 1];
  if (!first || !last) return;
  const width = ctx.canvas.width;
  const line = Math.max(3, Math.round(width / 300));
  if (shape.tool === "blur") {
    pixelate(ctx, spanRect(first, last), redactionBlock(width));
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = line;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (shape.tool === "rect") {
    const { x, y, w, h } = spanRect(first, last);
    ctx.globalAlpha = 0.15;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x, y, w, h);
  } else if (shape.tool === "arrow") {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const head = Math.max(14, line * 4);
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    for (const side of [-1, 1]) {
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - head * Math.cos(angle + side * 0.45), last.y - head * Math.sin(angle + side * 0.45));
    }
    ctx.stroke();
  } else {
    ctx.moveTo(first.x, first.y);
    for (const point of shape.points) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Paint the image, then every shape in order: a redaction also pixelates the marks under it. */
export function renderShapes(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  shapes: readonly Shape[],
  color: string,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const shape of shapes) drawShape(ctx, shape, color);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("[siteping] screenshot editor: the capture could not be decoded"));
    image.src = dataUrl;
  });
}

export interface ScreenshotEditorOptions {
  dataUrl: string;
  colors: ThemeColors;
  t: TFunction;
  kit: SurfaceKit;
}

/**
 * Open the editor over the page on a captured screenshot. Resolves the
 * marked-up image as a JPEG data URL of the same dimensions (so a
 * `ScreenshotRegion` computed for the capture still holds), the original
 * `dataUrl` when nothing was drawn, or `null` when the user cancels.
 */
export async function openScreenshotEditor({
  dataUrl,
  colors,
  t,
  kit,
}: ScreenshotEditorOptions): Promise<string | null> {
  const { el, setText, focusRing, pressable, isolateFromHost, addSurfaceKeydownListener, registerEscapeLayer } = kit;
  const image = await loadImage(dataUrl);
  const returnFocus = document.activeElement as HTMLElement | null;

  const root = el("div", {
    style: /* css */ `
      position:fixed;inset:0;z-index:${kit.zIndex};
      display:flex;flex-direction:column;align-items:center;gap:12px;
      padding:12px 16px 16px;box-sizing:border-box;
      background:rgba(0,0,0,0.82);
      font-family:${kit.font};color:#f5f5f7;
    `,
  });
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", t("editor.title"));
  root.setAttribute("data-siteping-ignore", "true");
  root.setAttribute("data-siteping-editor", "");

  const bar = el("div", {
    style: "display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;max-width:100%;",
  });
  const toolGroup = el("div", { role: "group", style: "display:flex;flex-wrap:wrap;gap:4px;" });
  toolGroup.setAttribute("aria-label", t("editor.title"));

  const button = (label: string, primary = false): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = /* css */ `
      min-height:36px;padding:0 14px;border:none;border-radius:9999px;cursor:pointer;
      font-family:${kit.font};font-size:14px;font-weight:${primary ? 600 : 500};
      color:#fff;background:${primary ? colors.accent : "rgba(255,255,255,0.16)"};
    `;
    setText(btn, label);
    pressable(btn);
    focusRing(btn, colors.accent);
    return btn;
  };

  let tool: EditorTool = "pen";
  const toolButtons = new Map<EditorTool, HTMLButtonElement>();
  const paintTools = () => {
    for (const [id, btn] of toolButtons) {
      const active = id === tool;
      btn.setAttribute("aria-pressed", String(active));
      btn.style.background = active ? colors.accent : "rgba(255,255,255,0.16)";
    }
  };
  for (const [id, key] of TOOLS) {
    const btn = button(t(key));
    btn.dataset.tool = id;
    btn.addEventListener("click", () => {
      tool = id;
      paintTools();
    });
    toolButtons.set(id, btn);
    toolGroup.appendChild(btn);
  }
  paintTools();

  const undoBtn = button(t("editor.undo"));
  const cancelBtn = button(t("editor.cancel"));
  const doneBtn = button(t("editor.done"), true);
  bar.append(toolGroup, undoBtn, cancelBtn, doneBtn);

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", t("editor.canvasAria"));
  canvas.style.cssText = /* css */ `
    max-width:100%;max-height:calc(100% - 64px);min-height:0;
    object-fit:contain;touch-action:none;cursor:crosshair;
    border-radius:8px;background:#fff;outline:none;
  `;
  focusRing(canvas, colors.accent);

  root.append(bar, canvas);
  isolateFromHost(root);
  document.body.appendChild(root);

  const ctx = canvas.getContext("2d");
  const shapes: Shape[] = [];
  let draft: Shape | null = null;
  let cursor: Point = { x: canvas.width / 2, y: canvas.height / 2 };
  let keyboardDrawing = false;

  const repaint = () => {
    if (!ctx) return;
    renderShapes(ctx, image, draft ? [...shapes, draft] : shapes, colors.accent);
    if (keyboardDrawing && document.activeElement === canvas) {
      // The keyboard crosshair — never part of the export (`finish` repaints without it).
      const arm = Math.max(10, canvas.width / 80);
      ctx.save();
      ctx.lineWidth = Math.max(2, canvas.width / 600);
      for (const [stroke, offset] of [
        ["#000", 1],
        ["#fff", 0],
      ] as const) {
        ctx.strokeStyle = stroke;
        ctx.beginPath();
        ctx.moveTo(cursor.x - arm + offset, cursor.y + offset);
        ctx.lineTo(cursor.x + arm + offset, cursor.y + offset);
        ctx.moveTo(cursor.x + offset, cursor.y - arm + offset);
        ctx.lineTo(cursor.x + offset, cursor.y + arm + offset);
        ctx.stroke();
      }
      ctx.restore();
    }
    undoBtn.disabled = shapes.length === 0;
    undoBtn.style.opacity = shapes.length === 0 ? "0.5" : "1";
  };

  const commit = () => {
    if (draft && isMeaningful(draft)) shapes.push(draft);
    draft = null;
    repaint();
  };

  const extend = (point: Point) => {
    if (!draft) return;
    if (draft.tool === "pen") draft.points.push(point);
    else draft.points[1] = point;
    repaint();
  };

  const toImage = (event: PointerEvent): Point => {
    const box = canvas.getBoundingClientRect();
    // Clamped: a drag may run past the image's edge, a shape stays on it.
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
    return {
      x: clamp(((event.clientX - box.left) / (box.width || 1)) * canvas.width, canvas.width),
      y: clamp(((event.clientY - box.top) / (box.height || 1)) * canvas.height, canvas.height),
    };
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    keyboardDrawing = false;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    draft = startShape(tool, toImage(event));
    repaint();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (draft) extend(toImage(event));
  });
  canvas.addEventListener("pointerup", commit);
  canvas.addEventListener("pointercancel", () => {
    draft = null;
    repaint();
  });
  canvas.addEventListener("blur", repaint);

  const undo = () => {
    draft = null;
    shapes.pop();
    repaint();
  };
  undoBtn.addEventListener("click", undo);

  const unregisterEscape = registerEscapeLayer(root, () => true);
  let settle: (value: string | null) => void = () => {};
  const result = new Promise<string | null>((resolve) => {
    settle = resolve;
  });

  const close = (value: string | null) => {
    removeKeydown();
    unregisterEscape();
    root.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    settle(value);
  };

  const finish = () => {
    if (!ctx || shapes.length === 0) return close(dataUrl);
    keyboardDrawing = false;
    draft = null;
    renderShapes(ctx, image, shapes, colors.accent);
    try {
      close(canvas.toDataURL("image/jpeg", EXPORT_QUALITY));
    } catch (error) {
      // A tainted canvas cannot be exported: never send the unredacted original in its place.
      console.warn("[siteping] screenshot editor: the marked-up image could not be exported", error);
      close(null);
    }
  };
  cancelBtn.addEventListener("click", () => close(null));
  doneBtn.addEventListener("click", finish);

  const removeKeydown = addSurfaceKeydownListener(root, (event) => {
    const key = event.key;
    if (key === "Escape") {
      // The annotation session listens on `document`: this Escape is the editor's.
      event.stopPropagation();
      event.preventDefault();
      if (draft) {
        draft = null;
        repaint();
      } else {
        close(null);
      }
      return;
    }
    if (key === "Tab") {
      const focusable = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), canvas")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.target !== canvas) return;
    const step = Math.max(4, Math.round(canvas.width / 100)) * (event.shiftKey ? 4 : 1);
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[key];
    if (move) {
      event.preventDefault();
      keyboardDrawing = true;
      cursor = {
        x: Math.min(canvas.width, Math.max(0, cursor.x + move[0])),
        y: Math.min(canvas.height, Math.max(0, cursor.y + move[1])),
      };
      if (draft) extend(cursor);
      else repaint();
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      keyboardDrawing = true;
      if (draft) commit();
      else {
        draft = startShape(tool, cursor);
        repaint();
      }
    }
  });

  repaint();
  canvas.focus({ preventScroll: true });
  return result;
}
