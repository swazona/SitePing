// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "../../src/i18n/index.js";
import { baseMimeType, formatDuration, pickMimeType, recordScreen } from "../../src/screen-recorder.js";
import { buildThemeColors } from "../../src/styles/theme.js";
import { surfaceKit as kit } from "../../src/surface-kit.js";

const colors = buildThemeColors();
const t = createT("en");

/** A MediaRecorder double: `start` arms it, `stop` flushes one chunk then fires `stop`. */
class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (type: string) => type === "video/webm;codecs=vp8";
  state: "inactive" | "recording" = "inactive";
  readonly mimeType: string;
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    this.mimeType = options.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  emit(bytes: number) {
    const event = new Event("dataavailable") as Event & { data: Blob };
    event.data = new Blob([new Uint8Array(bytes)]);
    this.dispatchEvent(event);
  }
  stop() {
    this.state = "inactive";
    this.emit(10);
    this.dispatchEvent(new Event("stop"));
  }
}

function fakeStream() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeRecorder.instances = [];
  getDisplayMedia = vi.fn();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const indicator = () => document.querySelector<HTMLElement>("[data-siteping-recording]");
const options = { maxDurationMs: 60_000, maxBytes: 8 * 1024 * 1024, colors, t, kit };

describe("screen recorder helpers", () => {
  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(61_500)).toBe("1:01");
  });

  it("picks the first container the browser records, and uploads it without codecs", () => {
    expect(pickMimeType((type) => type === "video/webm")).toBe("video/webm");
    expect(pickMimeType(() => false)).toBe("");
    expect(baseMimeType("video/mp4;codecs=avc1")).toBe("video/mp4");
    expect(baseMimeType("video/webm;codecs=vp9")).toBe("video/webm");
    expect(baseMimeType("")).toBe("video/webm");
  });
});

describe("recordScreen", () => {
  it("asks for the current tab, shows a stop control kept out of captures, and resolves the video on Stop", async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const done = recordScreen(options);
    await vi.waitFor(() => expect(indicator()).not.toBeNull());

    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ preferCurrentTab: true, audio: false }));
    expect(indicator()?.getAttribute("data-siteping-ignore")).toBe("true");
    expect(FakeRecorder.instances[0]?.options.mimeType).toBe("video/webm;codecs=vp8");
    const stop = indicator()?.querySelector("button");
    expect(stop?.textContent).toBe("Stop recording");
    expect(document.activeElement).toBe(stop);

    stop?.click();
    const recording = await done;
    expect(recording?.mimeType).toBe("video/webm");
    expect(recording?.blob.size).toBe(10);
    expect(track.stop).toHaveBeenCalled();
    expect(indicator()).toBeNull();
  });

  it("stops by itself at the duration limit", async () => {
    vi.useFakeTimers();
    getDisplayMedia.mockResolvedValue(fakeStream().stream);
    const done = recordScreen({ ...options, maxDurationMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await done)?.blob.size).toBe(10);
  });

  it("stops before the size limit", async () => {
    getDisplayMedia.mockResolvedValue(fakeStream().stream);
    const done = recordScreen({ ...options, maxBytes: 200_000 });
    await vi.waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
    FakeRecorder.instances[0]?.emit(100_000); // + a second of video would pass 200 kB
    expect((await done)?.blob.size).toBe(100_010);
  });

  it("stops when the visitor ends the share from the browser", async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const done = recordScreen(options);
    await vi.waitFor(() => expect(indicator()).not.toBeNull());
    track.dispatchEvent(new Event("ended"));
    expect(await done).not.toBeNull();
  });

  it("resolves null when the prompt is declined, and rejects on other failures", async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(recordScreen(options)).resolves.toBeNull();
    getDisplayMedia.mockRejectedValueOnce(new DOMException("no", "NotSupportedError"));
    await expect(recordScreen(options)).rejects.toThrow();
    expect(indicator()).toBeNull();
  });
});
