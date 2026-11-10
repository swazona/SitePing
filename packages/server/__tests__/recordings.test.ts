import { MemoryStore } from "@siteping/adapter-memory";
import type { FeedbackResponse, FeedbackResponseList, RecordingStorage } from "@siteping/core";
import { describe, expect, it, vi } from "vitest";
import { createSitepingHandler } from "../src/index.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const PROJECT = validPayloadNoAnnotations.projectName;
const BASE = "https://cdn.example.com/rec/";

/** A WebM file's first bytes (EBML header), padded. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3, 4]);
/** An MP4 file's first bytes (`ftyp` box). */
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function memoryRecordings() {
  const stored = new Map<string, { bytes: Uint8Array; mimeType: string; projectName: string; clientId: string }>();
  let n = 0;
  const storage: RecordingStorage = {
    async upload(bytes, ctx) {
      n += 1;
      const url = `${BASE}${n}`;
      stored.set(url, { bytes, ...ctx });
      return { url };
    },
    isOwnUrl: (url) => stored.has(url),
  };
  return { storage, stored };
}

function upload(body: Uint8Array, contentType = "video/webm", query = `projectName=${PROJECT}&clientId=cid-1`) {
  return new Request(`${ENDPOINT}?${query}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: body as Uint8Array<ArrayBuffer>,
  });
}

function create(diagnostics: unknown) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validPayloadNoAnnotations, diagnostics }),
  });
}

const recordingOf = (url: string) => ({ url, mimeType: "video/webm", durationMs: 4200, bytes: WEBM.byteLength });

describe("screen recordings", () => {
  it("advertises the capability only with a recordingStorage", async () => {
    const without = createSitepingHandler({ store: new MemoryStore() });
    const listed = (await (
      await without.GET(new Request(`${ENDPOINT}?projectName=${PROJECT}`))
    ).json()) as FeedbackResponseList;
    expect(listed.capabilities?.recordings).toBe(false);

    const withStorage = createSitepingHandler({
      store: new MemoryStore(),
      recordingStorage: memoryRecordings().storage,
    });
    const advertised = (await (
      await withStorage.GET(new Request(`${ENDPOINT}?projectName=${PROJECT}`))
    ).json()) as FeedbackResponseList;
    expect(advertised.capabilities?.recordings).toBe(true);
  });

  it("stores an upload and answers its URL", async () => {
    const { storage, stored } = memoryRecordings();
    const handler = createSitepingHandler({ store: new MemoryStore(), recordingStorage: storage });

    const response = await handler.POST(upload(WEBM));
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    expect(stored.get(url)).toMatchObject({ mimeType: "video/webm", projectName: PROJECT, clientId: "cid-1" });
    expect([...(stored.get(url)?.bytes ?? [])]).toEqual([...WEBM]);

    const mp4 = await handler.POST(upload(MP4, "video/mp4"));
    expect(mp4.status).toBe(201);
  });

  it("reads the type from the bytes, not the Content-Type", async () => {
    const { storage, stored } = memoryRecordings();
    const handler = createSitepingHandler({ store: new MemoryStore(), recordingStorage: storage });
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await handler.POST(upload(html))).status).toBe(400);

    const mislabelled = await handler.POST(upload(MP4, "video/webm"));
    const { url } = (await mislabelled.json()) as { url: string };
    expect(stored.get(url)?.mimeType).toBe("video/mp4");
  });

  it("refuses an upload without a recordingStorage, of another video type, or past maxRecordingBytes", async () => {
    const plain = createSitepingHandler({ store: new MemoryStore() });
    expect((await plain.POST(upload(WEBM))).status).toBe(415);

    const handler = createSitepingHandler({
      store: new MemoryStore(),
      recordingStorage: memoryRecordings().storage,
      maxRecordingBytes: 8,
    });
    expect((await handler.POST(upload(WEBM, "video/ogg"))).status).toBe(415);
    expect((await handler.POST(upload(WEBM))).status).toBe(413);
  });

  it("validates the query", async () => {
    const handler = createSitepingHandler({ store: new MemoryStore(), recordingStorage: memoryRecordings().storage });
    expect((await handler.POST(upload(WEBM, "video/webm", `projectName=${PROJECT}`))).status).toBe(400);
    expect((await handler.POST(upload(WEBM, "video/webm", `projectName=${PROJECT}&clientId=../x`))).status).toBe(400);
  });

  it("applies the create access rule to the upload", async () => {
    const authorize = vi.fn(() => false);
    const handler = createSitepingHandler({
      store: new MemoryStore(),
      recordingStorage: memoryRecordings().storage,
      access: { authenticate: () => ({ id: "u" }), authorize },
    });
    const response = await handler.POST(upload(WEBM));
    expect(response.status).toBe(403);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "create", projectName: PROJECT }));
  });

  it("keeps a feedback's recording only when the storage owns its URL", async () => {
    const { storage } = memoryRecordings();
    const handler = createSitepingHandler({ store: new MemoryStore(), recordingStorage: storage });
    const { url } = (await (await handler.POST(upload(WEBM))).json()) as { url: string };

    const kept = (await (
      await handler.POST(create({ console: [], network: [], recording: recordingOf(url) }))
    ).json()) as FeedbackResponse;
    expect(kept.diagnostics?.recording).toEqual(recordingOf(url));

    const foreign = (await (
      await handler.POST(
        new Request(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...validPayloadNoAnnotations,
            clientId: "uuid-456",
            diagnostics: { console: [], network: [], recording: recordingOf("https://evil.example/x.webm") },
          }),
        }),
      )
    ).json()) as FeedbackResponse;
    expect(foreign.diagnostics).toEqual({ console: [], network: [] });
  });

  it("drops a recording when no recordingStorage is configured", async () => {
    const handler = createSitepingHandler({ store: new MemoryStore() });
    const created = (await (
      await handler.POST(create({ console: [], network: [], recording: recordingOf(`${BASE}1`) }))
    ).json()) as FeedbackResponse;
    expect(created.diagnostics).toEqual({ console: [], network: [] });
  });

  it("stores the React component path, bounded", async () => {
    const handler = createSitepingHandler({ store: new MemoryStore() });
    const created = (await (
      await handler.POST(create({ console: [], network: [], components: ["App", "Layout", "Card"] }))
    ).json()) as FeedbackResponse;
    expect(created.diagnostics?.components).toEqual(["App", "Layout", "Card"]);

    const tooMany = await handler.POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validPayloadNoAnnotations,
          clientId: "uuid-789",
          diagnostics: { console: [], network: [], components: Array.from({ length: 31 }, () => "C") },
        }),
      }),
    );
    expect(tooMany.status).toBe(400);
  });

  it("refuses a non-positive maxRecordingBytes", () => {
    expect(() => createSitepingHandler({ store: new MemoryStore(), maxRecordingBytes: 0 })).toThrow(
      /maxRecordingBytes/,
    );
  });
});
