import type { CommentRecord, FeedbackRecord } from "@siteping/core";
import { vi } from "vitest";
import type { NotificationMessage, TeamNotificationComment } from "../src/index.js";

export function feedbackRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  const createdAt = new Date("2026-11-10T10:00:00.000Z");
  return {
    id: "fb_1",
    projectName: "acme",
    type: "bug",
    message: "The checkout button does nothing",
    status: "open",
    url: "/checkout?step=2",
    urlPattern: null,
    viewport: "1440x900",
    userAgent: "Mozilla/5.0",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    clientId: "client-1",
    resolvedAt: null,
    createdAt,
    updatedAt: new Date("2026-11-10T11:00:00.000Z"),
    annotations: [],
    screenshotUrl: "https://cdn.acme.com/shots/1.jpg",
    screenshotRegion: null,
    diagnostics: null,
    flowId: null,
    flowStep: null,
    flowTitle: null,
    ...overrides,
  };
}

export function reply(overrides: Partial<CommentRecord> = {}): TeamNotificationComment {
  return {
    id: "c_1",
    feedbackId: "fb_1",
    body: "Still broken on mobile",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    authorRole: "client",
    clientId: "comment-1",
    createdAt: new Date("2026-11-10T12:00:00.000Z"),
    projectName: "acme",
    ...overrides,
  };
}

export function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    event: "created",
    feedbackId: "fb_1",
    projectName: "acme",
    feedbackType: "bug",
    status: "open",
    title: "New bug on acme",
    summary: "The checkout button does nothing",
    fields: [
      { key: "project", label: "Project", value: "acme" },
      { key: "page", label: "Page", value: "/checkout" },
    ],
    links: [{ key: "screenshot", label: "Screenshot", url: "https://cdn.acme.com/shots/1.jpg" }],
    occurredAt: "2026-11-10T10:00:00.000Z",
    locale: "en",
    ...overrides,
  };
}

/** A `fetch` answering each call with the next response (the last one repeats), recording every request. */
export function mockFetch(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit; body: string; headers: Headers }> = [];
  let index = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      init,
      body: typeof init.body === "string" ? init.body : "",
      headers: new Headers(init.headers),
    });
    const next = responses[Math.min(index++, responses.length - 1)] ?? new Response("ok");
    return typeof next === "function" ? next() : next.clone();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
}

export const sendContext = () => ({ signal: new AbortController().signal, attempt: 1 });

/** Every Unicode character the hygiene must remove: bidi overrides and isolates, zero-widths, controls, BOM. */
export const INVISIBLES = "\u202E\u2066\u200B\u200D\u0007\uFEFF";
