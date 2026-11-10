import type { DiagnosticsSnapshot } from "@siteping/core";
import { describe, expect, it } from "vitest";
import { componentPath, safeRecording } from "../../src/format.js";
import { formatBytes, formatClock } from "../../src/media-format.js";

const recording = (overrides: Record<string, unknown> = {}) =>
  ({
    console: [],
    network: [],
    recording: {
      url: "https://cdn.example.com/rec/1.webm",
      mimeType: "video/webm",
      durationMs: 42_000,
      bytes: 1_400_000,
      ...overrides,
    },
  }) as unknown as DiagnosticsSnapshot;

describe("safeRecording", () => {
  it("is 'none' without diagnostics or a recording", () => {
    expect(safeRecording(null)).toBe("none");
    expect(safeRecording(undefined)).toBe("none");
    expect(safeRecording({ console: [], network: [] } as DiagnosticsSnapshot)).toBe("none");
  });

  it("keeps an absolute http(s) URL and the metadata", () => {
    expect(safeRecording(recording())).toEqual({
      url: "https://cdn.example.com/rec/1.webm",
      mimeType: "video/webm",
      durationMs: 42_000,
      bytes: 1_400_000,
    });
    expect(safeRecording(recording({ url: "http://localhost:9000/rec.mp4", mimeType: "video/mp4" }))).toMatchObject({
      url: "http://localhost:9000/rec.mp4",
      mimeType: "video/mp4",
    });
  });

  it.each([
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:video/webm;base64,GkXfow==",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://cdn.example.com/1",
    "file:///etc/passwd",
    "/relative/rec.webm",
    "//cdn.example.com/rec.webm",
    "not a url",
    "",
  ])("refuses %j as 'unsafe'", (url) => {
    expect(safeRecording(recording({ url }))).toBe("unsafe");
  });

  it("refuses a recording whose url is not a string, or that is not an object", () => {
    expect(safeRecording(recording({ url: 42 }))).toBe("unsafe");
    expect(
      safeRecording({ console: [], network: [], recording: "https://x.test/a.webm" } as unknown as DiagnosticsSnapshot),
    ).toBe("unsafe");
  });

  it("serializes the URL, so what reaches the DOM is what was checked", () => {
    const safe = safeRecording(recording({ url: "HTTPS://CDN.example.com/a b.webm" }));
    expect(safe).toMatchObject({ url: "https://cdn.example.com/a%20b.webm" });
  });

  it("drops malformed metadata instead of printing it", () => {
    expect(
      safeRecording(recording({ mimeType: 'video/webm" onerror="x', durationMs: Number.NaN, bytes: -1 })),
    ).toMatchObject({ mimeType: null, durationMs: null, bytes: null });
    expect(safeRecording(recording({ durationMs: "42", bytes: Number.POSITIVE_INFINITY }))).toMatchObject({
      durationMs: null,
      bytes: null,
    });
  });
});

describe("componentPath", () => {
  it("returns the names, root first", () => {
    expect(componentPath({ components: ["App", "Layout", "CheckoutForm"] })).toEqual(["App", "Layout", "CheckoutForm"]);
  });

  it("is empty without a path", () => {
    expect(componentPath(null)).toEqual([]);
    expect(componentPath({})).toEqual([]);
    expect(componentPath({ components: "App" as unknown as string[] })).toEqual([]);
  });

  it("drops non-strings and blank names, trims the rest", () => {
    expect(componentPath({ components: ["App", 3, " ", null, " Form "] as unknown as string[] })).toEqual([
      "App",
      "Form",
    ]);
  });

  it("keeps the 30 nearest components", () => {
    const names = Array.from({ length: 40 }, (_, i) => `C${i}`);
    const path = componentPath({ components: names });
    expect(path).toHaveLength(30);
    expect(path[0]).toBe("C10");
    expect(path.at(-1)).toBe("C39");
  });
});

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [999, "0:01"],
    [42_000, "0:42"],
    [65_000, "1:05"],
    [725_000, "12:05"],
    [3_723_000, "1:02:03"],
  ])("%d ms → %s", (ms, clock) => {
    expect(formatClock(ms)).toBe(clock);
  });
});

describe("formatBytes", () => {
  it("uses decimal units in the reader's locale", () => {
    expect(formatBytes(512, "en")).toBe("512 byte");
    expect(formatBytes(820_000, "en")).toBe("820 kB");
    expect(formatBytes(1_400_000, "en")).toBe("1.4 MB");
    expect(formatBytes(1_400_000, "fr")).toMatch(/^1,4\s?Mo$/);
    expect(formatBytes(2_500_000_000, "en")).toBe("2.5 GB");
  });
});
