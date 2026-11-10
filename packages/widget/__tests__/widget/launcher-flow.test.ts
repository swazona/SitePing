// @vitest-environment jsdom

import { MemoryStore } from "@siteping/adapter-memory";
import type { FeedbackPayload, FeedbackResponse, SitepingConfig, SitepingHttpConfig } from "@siteping/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockMatchMedia } from "../helpers.js";

// jsdom does not implement window.matchMedia — provide a stub
mockMatchMedia(false);

// ---------------------------------------------------------------------------
// Mock modules before importing launcher
// ---------------------------------------------------------------------------

const mockSendFeedback = vi.fn<(payload: FeedbackPayload) => Promise<FeedbackResponse>>();
const mockGetFeedbacks = vi.fn().mockResolvedValue({ feedbacks: [], total: 0 });
const mockAddComment = vi.fn();
const mockQueueOutcome = vi.fn<(error: unknown) => boolean | undefined>();

vi.mock(new URL("../../src/api-client.js", import.meta.url).pathname, () => ({
  queueOutcome: (error: unknown) => mockQueueOutcome(error),
  ApiClient: vi.fn(function (this: unknown) {
    return {
      sendFeedback: mockSendFeedback,
      getFeedbacks: mockGetFeedbacks,
      resolveFeedback: vi.fn(),
      deleteFeedback: vi.fn(),
      deleteAllFeedbacks: vi.fn(),
      addComment: mockAddComment,
    };
  }),
  flushRetryQueue: vi.fn().mockResolvedValue(undefined),
  // StoreClient's bound on a store write (store-mode tests)
  withTimeout: (promise: Promise<unknown>) => promise,
}));

// Capture the EventBus instance that launch() creates so we can emit events on it.
// The Annotator receives the bus in its constructor — we intercept it.
let capturedBus: {
  emit: (event: string, ...args: unknown[]) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => () => void;
} | null = null;

// Spy on annotator.refreshLabels so the i18n test can assert it gets called
// once the locale dictionary lands.
const mockAnnotatorRefreshLabels = vi.fn();

vi.mock(new URL("../../src/annotator.js", import.meta.url).pathname, () => ({
  Annotator: vi.fn(function (
    this: unknown,
    _colors: unknown,
    bus: {
      emit: (event: string, ...args: unknown[]) => void;
      on: (event: string, listener: (...args: unknown[]) => void) => () => void;
    },
  ) {
    capturedBus = bus;
    // Wire annotation:start listener like the real Annotator constructor does
    bus.on("annotation:start", () => {});
    return {
      destroy: vi.fn(),
      refreshLabels: mockAnnotatorRefreshLabels,
    };
  }),
}));

// Module-level marker spies so individual tests can assert against the same
// instance that launch() created. Reset by `vi.clearAllMocks` in afterEach.
const mockMarkersAddFeedback = vi.fn();
const mockMarkersRender = vi.fn();
const mockMarkersFocusFeedback = vi.fn().mockReturnValue(false);

vi.mock(new URL("../../src/markers.js", import.meta.url).pathname, () => ({
  MarkerManager: vi.fn(function (this: unknown) {
    return {
      render: mockMarkersRender,
      highlight: vi.fn(),
      pinHighlight: vi.fn(),
      addFeedback: mockMarkersAddFeedback,
      focusFeedback: mockMarkersFocusFeedback,
      isLost: vi.fn(() => false),
      destroy: vi.fn(),
      count: 0,
    };
  }),
}));

vi.mock(new URL("../../src/tooltip.js", import.meta.url).pathname, () => ({
  Tooltip: vi.fn(function (this: unknown) {
    return {
      tooltipId: "sp-tooltip",
      show: vi.fn(),
      scheduleHide: vi.fn(),
      contains: vi.fn(),
      destroy: vi.fn(),
    };
  }),
}));

vi.mock(new URL("../../src/styles/base.js", import.meta.url).pathname, () => ({
  buildStyles: vi.fn().mockReturnValue("/* styles */"),
}));

// Mock identity — simulate stored identity by default
const mockGetIdentity = vi.fn().mockReturnValue({ name: "Test User", email: "test@example.com" });
const mockSaveIdentity = vi.fn();

vi.mock(new URL("../../src/identity.js", import.meta.url).pathname, () => ({
  getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  saveIdentity: (...args: unknown[]) => mockSaveIdentity(...args),
}));

import { launch as launchWidget } from "../../src/launcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every handle a test opened, destroyed after it: the widget is a singleton, and a leftover would leak into the next test. */
const handles: Array<{ destroy(): void }> = [];
const launch: typeof launchWidget = (config) => {
  const instance = launchWidget(config);
  handles.push(instance);
  return instance;
};

const FLOW_KEY = `siteping_flow:${JSON.stringify(["test-project", "/api/siteping"])}`;

function defaultConfig(overrides: Partial<Omit<SitepingHttpConfig, "store">> = {}): SitepingConfig {
  return { endpoint: "/api/siteping", projectName: "test-project", forceShow: true, ...overrides };
}

function makeFeedbackResponse(): FeedbackResponse {
  const now = new Date().toISOString();
  return {
    id: `fb-${Math.random()}`,
    projectName: "test-project",
    type: "bug",
    message: "Step",
    status: "open",
    url: "/",
    viewport: "1920x1080",
    userAgent: "test",
    authorName: "Test User",
    authorEmail: "test@example.com",
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    annotations: [],
    urlPattern: null,
    screenshotUrl: null,
    screenshotRegion: null,
    diagnostics: null,
  };
}

function annotationComplete(clientId: string) {
  return {
    annotation: {
      anchor: {
        cssSelector: "div.test",
        xpath: "/html/body/div",
        textSnippet: "test",
        elementTag: "DIV",
        textPrefix: "",
        textSuffix: "",
        fingerprint: "0:0:0",
        neighborText: "",
      },
      rect: { xPct: 0, yPct: 0, wPct: 1, hPct: 1 },
      scrollX: 0,
      scrollY: 0,
      viewportW: 1920,
      viewportH: 1080,
      devicePixelRatio: 1,
    },
    type: "bug",
    message: `Step ${clientId}`,
    clientId,
  };
}

const shadow = () => document.querySelector("siteping-widget")!.shadowRoot!;
const flowItem = () => shadow().querySelector<HTMLButtonElement>('[data-item-id="flow"]');
const strip = () => shadow().querySelector<HTMLElement>(".sp-flow");
const stripText = () => strip()?.querySelector(".sp-flow > .sp-flow-label")?.textContent;

/** Send one comment through the launcher and wait for its payload. */
async function send(clientId: string): Promise<FeedbackPayload> {
  const calls = mockSendFeedback.mock.calls.length;
  capturedBus!.emit("annotation:complete", annotationComplete(clientId));
  await vi.waitFor(() => expect(mockSendFeedback.mock.calls.length).toBe(calls + 1));
  // Let the handler finish what follows the send (advancing the step).
  await new Promise((resolve) => setTimeout(resolve, 0));
  return mockSendFeedback.mock.calls[calls]![0];
}

/** Start a flow from the FAB item and answer its title form. */
async function startFlow(title: string): Promise<void> {
  capturedBus!.emit("flow:toggle");
  await vi.waitFor(() => expect(strip()?.querySelector("input")).toBe(shadow().activeElement));
  strip()!.querySelector("input")!.value = title;
  strip()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await vi.waitFor(() => expect(sessionStorage.getItem(FLOW_KEY)).not.toBeNull());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("launcher — multi-page flows", () => {
  beforeEach(() => {
    mockSendFeedback.mockImplementation(async () => makeFeedbackResponse());
  });

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.destroy();
    for (const el of document.querySelectorAll("siteping-widget")) el.remove();
    for (const el of document.querySelectorAll('[role="status"]')) el.remove();
    capturedBus = null;
    vi.clearAllMocks();
    mockQueueOutcome.mockReset();
    mockGetFeedbacks.mockResolvedValue({ feedbacks: [], total: 0 });
    sessionStorage.clear();
  });

  it("offers 'Start a flow' only once the server reports protocol 2", async () => {
    mockGetFeedbacks.mockResolvedValue({ feedbacks: [], total: 0, protocol: 1 });
    const old = launch(defaultConfig());
    await vi.waitFor(() => expect(mockGetFeedbacks).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowItem()).toBeNull();
    old.destroy();

    mockGetFeedbacks.mockResolvedValue({ feedbacks: [], total: 0, protocol: 2 });
    const instance = launch(defaultConfig());
    await vi.waitFor(() => expect(flowItem()).not.toBeNull());
    instance.destroy();
  });

  it("offers it in store mode, where the store keeps whatever it is handed", () => {
    const instance = launch({ store: new MemoryStore(), projectName: "test-project", forceShow: true });
    expect(flowItem()).not.toBeNull();
    instance.destroy();
  });

  it("sends each comment as the next step, with the flow's id and title, until Finish", async () => {
    const instance = launch(defaultConfig());
    await startFlow("  Sign-up ");
    expect(stripText()).toBe("Flow: Sign-up · step 1");
    expect(flowItem()?.getAttribute("aria-label")).toBe("Finish the flow");

    const first = await send("c1");
    const second = await send("c2");
    expect(first).toMatchObject({ flowStep: 1, flowTitle: "Sign-up" });
    expect(second).toMatchObject({ flowId: first.flowId, flowStep: 2, flowTitle: "Sign-up" });
    expect(first.flowId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(stripText()).toBe("Flow: Sign-up · step 3");

    // Finish, from the strip: the next comment is outside any flow.
    Array.from(strip()!.querySelectorAll("button"))
      .find((b) => b.textContent === "Finish")!
      .click();
    expect(strip()!.hidden).toBe(true);
    expect(sessionStorage.getItem(FLOW_KEY)).toBeNull();
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("Flow finished");
    const after = await send("c3");
    expect(after).not.toHaveProperty("flowId");
    expect(after).not.toHaveProperty("flowStep");

    instance.destroy();
  });

  it("starts an untitled flow from an empty title, and the FAB item finishes it", async () => {
    const instance = launch(defaultConfig());
    await startFlow("");
    expect(stripText()).toBe("Flow · step 1");
    expect((await send("c1")).flowTitle).toBeNull();

    capturedBus!.emit("flow:toggle");
    expect(sessionStorage.getItem(FLOW_KEY)).toBeNull();
    expect(strip()!.hidden).toBe(true);
    instance.destroy();
  });

  it("starts nothing when the title form is cancelled", async () => {
    const instance = launch(defaultConfig());
    capturedBus!.emit("flow:toggle");
    await vi.waitFor(() => expect(strip()?.querySelector("input")).toBe(shadow().activeElement));
    strip()!
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionStorage.getItem(FLOW_KEY)).toBeNull();
    expect((await send("c1")).flowId).toBeUndefined();
    instance.destroy();
  });

  it("resumes the flow of this tab after a reload or a page load, at its next step", async () => {
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({ id: "flow-resumed", title: "Checkout", step: 3 }));
    // A server older than flows: the active flow still shows, so it can be finished.
    mockGetFeedbacks.mockResolvedValue({ feedbacks: [], total: 0 });

    const instance = launch(defaultConfig());
    await vi.waitFor(() => expect(stripText()).toBe("Flow: Checkout · step 3"));
    expect(flowItem()?.getAttribute("aria-label")).toBe("Finish the flow");
    expect(await send("c1")).toMatchObject({ flowId: "flow-resumed", flowStep: 3, flowTitle: "Checkout" });
    expect(JSON.parse(sessionStorage.getItem(FLOW_KEY)!)).toEqual({ id: "flow-resumed", title: "Checkout", step: 4 });
    instance.destroy();
  });

  it("follows SPA navigation: each step carries the page it was sent from", async () => {
    let scope = { url: "/signup", urlPattern: null };
    const instance = launch(defaultConfig({ getPageScope: () => scope }));
    await startFlow("Sign-up");
    const first = await send("c1");
    scope = { url: "/verify", urlPattern: null };
    history.pushState(null, "", "/verify");
    const second = await send("c2");

    expect([first.url, second.url]).toEqual(["/signup", "/verify"]);
    expect([first.flowStep, second.flowStep]).toEqual([1, 2]);
    expect(second.flowId).toBe(first.flowId);
    history.replaceState(null, "", "/");
    instance.destroy();
  });

  it("counts a step saved for the next page load, and not one the server refused", async () => {
    const instance = launch(defaultConfig());
    await startFlow("Sign-up");

    mockSendFeedback.mockRejectedValueOnce(new Error("offline"));
    mockQueueOutcome.mockReturnValueOnce(true);
    expect((await send("queued")).flowStep).toBe(1);
    await vi.waitFor(() => expect(stripText()).toBe("Flow: Sign-up · step 2"));

    mockSendFeedback.mockRejectedValueOnce(new Error("400"));
    mockQueueOutcome.mockReturnValueOnce(false);
    expect((await send("refused")).flowStep).toBe(2);
    expect(stripText()).toBe("Flow: Sign-up · step 2");
    expect((await send("retried")).flowStep).toBe(2);

    instance.destroy();
  });

  it("finishes the flow after its hundredth step", async () => {
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({ id: "long", title: null, step: 100 }));
    const instance = launch(defaultConfig());
    expect((await send("last")).flowStep).toBe(100);
    expect(sessionStorage.getItem(FLOW_KEY)).toBeNull();
    expect(flowItem()?.getAttribute("aria-label")).toBe("Start a flow");
    instance.destroy();
  });
});
