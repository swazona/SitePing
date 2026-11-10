// @vitest-environment jsdom
// Capture features end to end through the real launcher, Annotator, Popup and
// HTTP client: the "Record screen" action and its upload, the React
// component path, and the `online` replay of the offline queue. Only the DOM
// anchor helpers are mocked (jsdom has no layout), as in submit-unbounded-wait.
import type { FeedbackPayload, SitepingConfig } from "@siteping/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launch } from "../../src/launcher.js";
import { _resetOfflineQueueForTests } from "../../src/offline-queue.js";
import { mockMatchMedia } from "../helpers.js";

mockMatchMedia(false);

vi.mock(new URL("../../src/dom/anchor.js", import.meta.url).pathname, () => ({
  findAnchorElement: vi.fn().mockReturnValue(document.body),
  generateAnchor: vi.fn().mockReturnValue({
    cssSelector: "body",
    xpath: "/html/body",
    textSnippet: "",
    elementTag: "BODY",
    elementId: undefined,
    textPrefix: "",
    textSuffix: "",
    fingerprint: "0:0:0",
    neighborText: "",
  }),
  rectToPercentages: vi.fn().mockReturnValue({ xPct: 0, yPct: 0, wPct: 1, hPct: 1 }),
}));

const endpoint = "http://localhost/api/siteping";
const base = { projectName: "p", forceShow: true, identity: { name: "Ada", email: "ada@example.com" } } as const;
const flush = () => new Promise((r) => setTimeout(r, 30));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const shadow = () => document.querySelector("siteping-widget")!.shadowRoot!;
const fabItem = (id: string) => shadow().querySelector<HTMLButtonElement>(`[data-item-id="${id}"]`);

type Call = { url: string; init: RequestInit };
let calls: Call[];
let recordings = true;

function stubServer() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (!init.method || init.method === "GET") {
        return new Response(JSON.stringify({ feedbacks: [], total: 0, capabilities: { comments: true, recordings } }), {
          status: 200,
        });
      }
      if (init.body instanceof Blob) return new Response(JSON.stringify({ url: "https://cdn/rec/1" }), { status: 201 });
      const sent = JSON.parse(String(init.body)) as FeedbackPayload;
      return new Response(JSON.stringify({ id: "fb-1", ...sent, annotations: [], status: "open" }), { status: 201 });
    }),
  );
}

/** MediaRecorder + getDisplayMedia doubles: Stop yields a 10-byte WebM. */
class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "video/webm;codecs=vp9";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable") as Event & { data: Blob };
    event.data = new Blob([new Uint8Array(10)]);
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}

function stubRecordingSupport() {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const track = Object.assign(new EventTarget(), { stop: () => {} });
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    configurable: true,
  });
}

let instance: ReturnType<typeof launch> | undefined;

async function start(config: Partial<SitepingConfig> = {}) {
  instance = launch({ ...base, endpoint, ...config } as SitepingConfig);
  await flush();
}

async function drawAndFill() {
  const overlay = document.querySelector<HTMLElement>('div[role="application"]')!;
  overlay.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
  overlay.dispatchEvent(new MouseEvent("mouseup", { clientX: 200, clientY: 200, bubbles: true }));
  await flush();
  const textarea = dialog().querySelector("textarea")!;
  textarea.value = "it breaks";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

const send = () => [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Send")!.click();
const posted = () =>
  calls
    .filter((c) => c.init.method === "POST" && typeof c.init.body === "string")
    .map((c) => JSON.parse(String(c.init.body)) as FeedbackPayload);

beforeEach(() => {
  recordings = true;
  stubServer();
});

afterEach(() => {
  instance?.destroy();
  instance = undefined;
  _resetOfflineQueueForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaDevices");
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("Record screen", () => {
  it("is offered once the endpoint advertises recordings, in a browser that can record", async () => {
    stubRecordingSupport();
    await start({ enableScreenRecording: true });
    expect(fabItem("record")).not.toBeNull();
    // After "Create new annotation".
    expect(fabItem("annotate")?.nextElementSibling).toBe(fabItem("record"));
  });

  it("is hidden when the server does not take recordings, when not enabled, or where the browser cannot record (iOS Safari)", async () => {
    stubRecordingSupport();
    recordings = false;
    await start({ enableScreenRecording: true });
    expect(fabItem("record")).toBeNull();
    instance?.destroy();

    recordings = true;
    await start();
    expect(fabItem("record")).toBeNull();
    instance?.destroy();

    Reflect.deleteProperty(navigator, "mediaDevices"); // no getDisplayMedia
    await start({ enableScreenRecording: true });
    expect(fabItem("record")).toBeNull();
  });

  it("records, then annotates: the video is uploaded first and named in diagnostics.recording", async () => {
    stubRecordingSupport();
    await start({ enableScreenRecording: { maxDurationMs: 30_000 } });
    fabItem("record")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-siteping-recording]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-siteping-recording] button")!.click();
    await vi.waitFor(() => expect(document.querySelector('div[role="application"]')).not.toBeNull());

    await drawAndFill();
    const chip = [...dialog().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Recording"));
    expect(chip?.getAttribute("aria-label")).toContain("Remove the recording");
    send();
    await vi.waitFor(() => expect(posted()).toHaveLength(1));

    const upload = calls.find((c) => c.init.body instanceof Blob);
    expect(upload?.url).toMatch(/\?projectName=p&clientId=/);
    expect(upload?.init.headers).toMatchObject({ "Content-Type": "video/webm" });
    expect(posted()[0]?.diagnostics?.recording).toMatchObject({
      url: "https://cdn/rec/1",
      mimeType: "video/webm",
      bytes: 10,
    });
  });

  it("can be detached from the form before sending", async () => {
    stubRecordingSupport();
    await start({ enableScreenRecording: true });
    fabItem("record")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-siteping-recording]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-siteping-recording] button")!.click();
    await vi.waitFor(() => expect(document.querySelector('div[role="application"]')).not.toBeNull());
    await drawAndFill();
    [...dialog().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Recording"))!.click();
    send();
    await vi.waitFor(() => expect(posted()).toHaveLength(1));
    expect(calls.some((c) => c.init.body instanceof Blob)).toBe(false);
    expect(posted()[0]?.diagnostics).toBeNull();
  });
});

describe("React component path", () => {
  it("is sent in diagnostics.components with captureDiagnostics, and only then", async () => {
    Object.assign(document.body, {
      __reactFiber$t: { type: function Checkout() {}, return: { type: function App() {} } },
    });
    try {
      await start({ captureDiagnostics: { console: false, network: false } });
      fabItem("annotate")!.click();
      await flush();
      await drawAndFill();
      send();
      await vi.waitFor(() => expect(posted()).toHaveLength(1));
      expect(posted()[0]?.diagnostics).toEqual({ console: [], network: [], components: ["App", "Checkout"] });
      instance?.destroy();
      document.body.innerHTML = "";

      calls = [];
      await start({ captureDiagnostics: { components: false, console: false, network: false } });
      fabItem("annotate")!.click();
      await flush();
      await drawAndFill();
      send();
      await vi.waitFor(() => expect(posted()).toHaveLength(1));
      expect(posted()[0]?.diagnostics).toBeNull();
    } finally {
      Reflect.deleteProperty(document.body, "__reactFiber$t");
    }
  });
});

describe("offline queue", () => {
  it("replays the queue when the browser comes back online, then refreshes the pins", async () => {
    await start();
    const payload: FeedbackPayload = {
      projectName: "p",
      type: "bug",
      message: "offline",
      url: "/",
      viewport: "1x1",
      userAgent: "ua",
      authorName: "Ada",
      authorEmail: "ada@example.com",
      annotations: [],
      clientId: "c-off",
    };
    const queued = { endpoint, payload };
    localStorage.setItem("siteping_retry_queue", JSON.stringify([queued]));
    const listsBefore = calls.filter((c) => !c.init.method || c.init.method === "GET").length;

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(posted().map((p) => p.clientId)).toEqual(["c-off"]));
    expect(localStorage.getItem("siteping_retry_queue")).toBeNull();
    await vi.waitFor(() =>
      expect(calls.filter((c) => !c.init.method || c.init.method === "GET").length).toBeGreaterThan(listsBefore),
    );
  });

  it("stops listening once destroyed", async () => {
    await start();
    instance?.destroy();
    instance = undefined;
    localStorage.setItem(
      "siteping_retry_queue",
      JSON.stringify([{ endpoint, payload: { authorName: "Ada", authorEmail: "ada@example.com", clientId: "x" } }]),
    );
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(posted()).toHaveLength(0);
  });
});
