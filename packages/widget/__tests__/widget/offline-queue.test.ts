// @vitest-environment jsdom
// The offline queue's tiers and recordings. jsdom has no IndexedDB, so these
// run the localStorage and memory tiers; the IndexedDB tier runs in a real
// browser in e2e/capture.spec.ts.
import type { FeedbackPayload } from "@siteping/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  buildRequestHeaders,
  flushRetryQueue,
  hasQueuedFeedback,
  queueOutcome,
} from "../../src/api-client.js";
import {
  _resetOfflineQueueForTests,
  configureOfflineQueue,
  enqueue,
  flush,
  hasMemoryEntries,
  MAX_QUEUED_RECORDINGS,
} from "../../src/offline-queue.js";
import type { PendingRecording } from "../../src/recording-upload.js";

const endpoint = "http://localhost/api/siteping";

const payload = (clientId: string): FeedbackPayload => ({
  projectName: "p",
  type: "bug",
  message: `message ${clientId}`,
  url: "/",
  viewport: "1x1",
  userAgent: "ua",
  authorName: "Ada",
  authorEmail: "ada@example.com",
  annotations: [],
  clientId,
});

const recording = (): PendingRecording => ({
  blob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "video/webm" }),
  mimeType: "video/webm",
  durationMs: 4200,
});

const created = (id = "fb-1") => new Response(JSON.stringify({ id }), { status: 201 });

beforeEach(() => {
  // What api-client hands the chunk when it loads it (these tests import it directly).
  configureOfflineQueue({
    retryQueueKey: "siteping_retry_queue",
    outboxFlagKey: "siteping_outbox",
    timeoutMs: 10_000,
    buildRequestHeaders,
    isTransientStatus: (status) => status >= 500 || status === 408 || status === 429,
    markOwn: () => {},
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  _resetOfflineQueueForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("offline queue", () => {
  it("keeps a feedback with a recording in memory without IndexedDB — localStorage cannot hold the video", async () => {
    expect(await enqueue(endpoint, payload("c1"), recording())).toBe(true);
    expect(localStorage.getItem("siteping_retry_queue")).toBeNull();
    expect(hasMemoryEntries()).toBe(true);
    expect(hasQueuedFeedback()).toBe(false); // the module was not loaded through api-client yet
  });

  it("replays a queued recording: upload first, then the feedback naming it", async () => {
    await enqueue(endpoint, payload("c1"), recording());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn/rec/1" }), { status: 201 }))
      .mockResolvedValueOnce(created());

    expect(await flush(endpoint)).toBe(1);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] ?? [];
    expect(uploadUrl).toBe(`${endpoint}?projectName=p&clientId=c1`);
    expect(uploadInit?.headers).toMatchObject({ "Content-Type": "video/webm" });
    expect(uploadInit?.body).toBeInstanceOf(Blob);
    const sent = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as FeedbackPayload;
    expect(sent.diagnostics?.recording).toEqual({
      url: "https://cdn/rec/1",
      mimeType: "video/webm",
      durationMs: 4200,
      bytes: 4,
    });
    expect(hasMemoryEntries()).toBe(false);
  });

  it("keeps the entry when the upload fails on the network, sends the feedback alone when the server refuses the video", async () => {
    await enqueue(endpoint, payload("c1"), recording());
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await flush(endpoint)).toBe(0);
    expect(hasMemoryEntries()).toBe(true);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("too large", { status: 413 }))
      .mockResolvedValueOnce(created());
    expect(await flush(endpoint)).toBe(1);
    const sent = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as FeedbackPayload;
    expect(sent.diagnostics?.recording).toBeUndefined();
  });

  it("dedupes by clientId — a resend replaces its earlier attempt", async () => {
    await enqueue(endpoint, { ...payload("c1"), message: "first" });
    await enqueue(endpoint, { ...payload("c1"), message: "edited" });
    const queue = JSON.parse(localStorage.getItem("siteping_retry_queue") ?? "[]") as Array<{
      payload: FeedbackPayload;
    }>;
    expect(queue.map((entry) => entry.payload.message)).toEqual(["edited"]);
  });

  it(`keeps at most ${MAX_QUEUED_RECORDINGS} recordings — older feedbacks keep their text, not their video`, async () => {
    for (let i = 0; i < MAX_QUEUED_RECORDINGS + 2; i++) await enqueue(endpoint, payload(`c${i}`), recording());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) =>
        init?.body instanceof Blob
          ? new Response(JSON.stringify({ url: "https://cdn/r" }), { status: 201 })
          : created(),
      );
    expect(await flush(endpoint)).toBe(MAX_QUEUED_RECORDINGS + 2);
    const uploads = fetchMock.mock.calls.filter(([, init]) => init?.body instanceof Blob);
    expect(uploads).toHaveLength(MAX_QUEUED_RECORDINGS);
  });

  it("is replayed through flushRetryQueue once this page holds memory entries", async () => {
    // A send that fails offline loads the queue through the client…
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const client = new ApiClient(endpoint, "p");
    const failure = client.sendFeedback(payload("c9"), recording()).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(queueOutcome(await failure)).toBe(true);
    vi.useRealTimers();
    expect(hasQueuedFeedback()).toBe(true);

    // …and coming back online replays it.
    vi.mocked(fetch)
      .mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn/r" }), { status: 201 }))
      .mockResolvedValueOnce(created());
    expect(await flushRetryQueue(endpoint)).toBe(1);
    expect(hasQueuedFeedback()).toBe(false);
  });
});
