// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "../../src/i18n/index.js";
import {
  drawShape,
  isMeaningful,
  openScreenshotEditor,
  pixelate,
  redactionBlock,
  type Shape,
  spanRect,
} from "../../src/screenshot-editor.js";
import { buildThemeColors } from "../../src/styles/theme.js";
import { surfaceKit as kit } from "../../src/surface-kit.js";

const colors = buildThemeColors("#0066ff");
const t = createT("en");

/** A 2D context that records the calls the editor makes — jsdom has no canvas. */
function fakeContext(canvas: HTMLCanvasElement) {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ctx = {
    canvas,
    calls,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    save: record("save"),
    restore: record("restore"),
    clearRect: record("clearRect"),
    drawImage: record("drawImage"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
  };
  return ctx;
}

let contexts: Array<ReturnType<typeof fakeContext>>;

beforeEach(() => {
  contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const ctx = fakeContext(this);
    contexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,EDITED");
  // An image that "decodes" at once, 600×300.
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 600;
      naturalHeight = 300;
      width = 600;
      height = 300;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const editor = () => document.querySelector<HTMLElement>("[data-siteping-editor]");
const canvas = () => editor()?.querySelector("canvas") as HTMLCanvasElement;
const buttonNamed = (label: string) =>
  [...(editor()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label) as HTMLButtonElement;
const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));

/** Open the editor and wait for it to show; `result` settles when it closes. */
async function open(): Promise<{ result: Promise<string | null> }> {
  const result = openScreenshotEditor({ dataUrl: "data:image/jpeg;base64,ORIG", colors, t, kit });
  await vi.waitFor(() => expect(editor()).not.toBeNull());
  return { result };
}

describe("shape geometry", () => {
  it("spans a rectangle from any two corners", () => {
    expect(spanRect({ x: 50, y: 10 }, { x: 20, y: 40 })).toEqual({ x: 20, y: 10, w: 30, h: 30 });
  });

  it("drops clicks that draw nothing", () => {
    expect(isMeaningful({ tool: "pen", points: [{ x: 1, y: 1 }] })).toBe(false);
    expect(
      isMeaningful({
        tool: "rect",
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 30 },
        ],
      }),
    ).toBe(false);
    expect(
      isMeaningful({
        tool: "blur",
        points: [
          { x: 1, y: 1 },
          { x: 20, y: 30 },
        ],
      }),
    ).toBe(true);
    expect(
      isMeaningful({
        tool: "arrow",
        points: [
          { x: 1, y: 1 },
          { x: 1, y: 9 },
        ],
      }),
    ).toBe(true);
  });

  it("redacts with blocks coarse enough to hide text, scaled to the image", () => {
    expect(redactionBlock(300)).toBe(12);
    expect(redactionBlock(2400)).toBe(40);
  });
});

describe("pixelate", () => {
  it("averages the area through a smaller canvas, then draws it back without smoothing", () => {
    const target = document.createElement("canvas");
    target.width = 200;
    target.height = 100;
    const ctx = target.getContext("2d") as unknown as ReturnType<typeof fakeContext>;
    pixelate(ctx as unknown as CanvasRenderingContext2D, { x: 10, y: 10, w: 48, h: 24 }, 12);

    const small = contexts[1];
    expect(small?.canvas.width).toBe(4);
    expect(small?.canvas.height).toBe(2);
    // Shrunk from the area…
    expect(small?.calls).toContainEqual(["drawImage", target, 10, 10, 48, 24, 0, 0, 4, 2]);
    // …and blown back up over it, pixels replaced.
    expect(ctx.calls).toContainEqual(["drawImage", small?.canvas, 0, 0, 4, 2, 10, 10, 48, 24]);
  });

  it("clips the area to the canvas", () => {
    const target = document.createElement("canvas");
    target.width = 50;
    target.height = 50;
    const ctx = target.getContext("2d") as unknown as ReturnType<typeof fakeContext>;
    pixelate(ctx as unknown as CanvasRenderingContext2D, { x: 40, y: -5, w: 30, h: 20 }, 12);
    expect(ctx.calls.find((c) => c[0] === "drawImage")?.slice(-4)).toEqual([40, 0, 10, 20]);
  });

  it("draws a highlight in the accent and an arrow with its head", () => {
    const target = document.createElement("canvas");
    target.width = 300;
    const ctx = target.getContext("2d") as unknown as ReturnType<typeof fakeContext>;
    const rect: Shape = {
      tool: "rect",
      points: [
        { x: 10, y: 10 },
        { x: 60, y: 40 },
      ],
    };
    drawShape(ctx as unknown as CanvasRenderingContext2D, rect, "#0066ff");
    expect(ctx.strokeStyle).toBe("#0066ff");
    expect(ctx.calls).toContainEqual(["strokeRect", 10, 10, 50, 30]);

    ctx.calls.length = 0;
    drawShape(
      ctx as unknown as CanvasRenderingContext2D,
      {
        tool: "arrow",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
      "red",
    );
    expect(ctx.calls.filter((c) => c[0] === "moveTo")).toHaveLength(3); // shaft + two barbs
  });
});

describe("openScreenshotEditor", () => {
  it("is a labelled modal dialog, kept out of captures, with the tools as toggle buttons", async () => {
    await open();
    const root = editor() as HTMLElement;
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(root.getAttribute("aria-label")).toBe("Mark up screenshot");
    expect(root.getAttribute("data-siteping-ignore")).toBe("true");
    expect(buttonNamed("Pen").getAttribute("aria-pressed")).toBe("true");
    buttonNamed("Redact").click();
    expect(buttonNamed("Redact").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("Pen").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(canvas());
    expect(canvas().width).toBe(600);
    buttonNamed("Cancel").click();
  });

  it("resolves the original image when nothing was drawn, and null on Cancel", async () => {
    const untouched = await open();
    buttonNamed("Done").click();
    await expect(untouched.result).resolves.toBe("data:image/jpeg;base64,ORIG");

    const cancelled = await open();
    buttonNamed("Cancel").click();
    await expect(cancelled.result).resolves.toBeNull();
    expect(editor()).toBeNull();
  });

  it("draws with the keyboard — arrows move, Enter starts and ends — and exports the edited JPEG", async () => {
    const { result } = await open();
    buttonNamed("Redact").click();
    canvas().focus();
    key(canvas(), "Enter");
    for (let i = 0; i < 5; i++) key(canvas(), "ArrowRight", { shiftKey: true });
    key(canvas(), "ArrowDown", { shiftKey: true });
    key(canvas(), "Enter");
    expect(buttonNamed("Undo").disabled).toBe(false);

    buttonNamed("Done").click();
    await expect(result).resolves.toBe("data:image/jpeg;base64,EDITED");
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
  });

  it("undoes with the button and Ctrl+Z", async () => {
    const { result } = await open();
    canvas().focus();
    key(canvas(), "Enter");
    key(canvas(), "ArrowRight");
    key(canvas(), "ArrowRight");
    key(canvas(), "Enter");
    expect(buttonNamed("Undo").disabled).toBe(false);
    key(canvas(), "z", { ctrlKey: true });
    expect(buttonNamed("Undo").disabled).toBe(true);
    buttonNamed("Done").click();
    await expect(result).resolves.toBe("data:image/jpeg;base64,ORIG");
  });

  it("draws with a pointer (mouse, pen or touch)", async () => {
    const { result } = await open();
    const c = canvas();
    vi.spyOn(c, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 150)); // shown at half size
    const pointer = (type: string, x: number, y: number) =>
      c.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    buttonNamed("Highlight").click();
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 60, 40);
    pointer("pointerup", 60, 40);

    const main = contexts[0];
    expect(main?.calls).toContainEqual(["strokeRect", 20, 20, 100, 60]); // in image pixels
    buttonNamed("Done").click();
    await expect(result).resolves.toBe("data:image/jpeg;base64,EDITED");
  });

  it("Escape drops a shape in progress first, then closes — without reaching the page", async () => {
    const pageEscape = vi.fn();
    const onPageKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") pageEscape();
    };
    document.addEventListener("keydown", onPageKey);
    const { result } = await open();
    canvas().focus();
    key(canvas(), "Enter");
    key(canvas(), "Escape");
    expect(editor()).not.toBeNull();
    key(canvas(), "Escape");
    await expect(result).resolves.toBeNull();
    expect(pageEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onPageKey);
  });

  it("traps Tab inside the dialog", async () => {
    await open();
    canvas().focus(); // the last focusable
    key(canvas(), "Tab");
    expect(document.activeElement).toBe(buttonNamed("Pen"));
    key(buttonNamed("Pen"), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(canvas());
    buttonNamed("Cancel").click();
  });

  it("never sends the unredacted original when the export fails", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await open();
    canvas().focus();
    key(canvas(), "Enter");
    key(canvas(), "ArrowRight", { shiftKey: true });
    key(canvas(), "ArrowDown", { shiftKey: true });
    key(canvas(), "Enter");
    buttonNamed("Done").click();
    await expect(result).resolves.toBeNull();
  });
});
