import {
  type AnnotationPayload,
  type CommentCreateInput,
  type CommentResponse,
  errorFromResponse,
  type FeedbackPayload,
  type FeedbackQuery,
  type FeedbackResponse,
  type FeedbackResponseList,
  feedbackQueryToSearchParams,
  mergeRequestHeaders,
  networkErrorFromException,
  type Prettify,
  SitepingAuthError,
  SitepingError,
  type SitepingHeadersOption,
  type SitepingIdentity,
  SitepingNetworkError,
  withSearchParams,
} from "@siteping/core";
import { ownFeedback } from "./own-feedback.js";
import type { PendingRecording } from "./recording-upload.js";

/**
 * Abstract client interface used by the widget internals.
 *
 * `ApiClient` (HTTP mode) and `StoreClient` (direct store mode) both satisfy
 * this interface, allowing the widget to work identically in either mode.
 */
export interface WidgetClient {
  /**
   * Send a feedback. With a `recording`, the HTTP client uploads it first and
   * names it in `diagnostics.recording` (see `recording-upload.ts`); a store
   * has nowhere to put one and ignores it.
   */
  sendFeedback(payload: FeedbackPayload, recording?: PendingRecording): Promise<FeedbackResponse>;
  getFeedbacks(projectName: string, options?: GetFeedbacksOptions): Promise<FeedbackResponseList>;
  resolveFeedback(id: string, resolved: boolean): Promise<FeedbackResponse>;
  deleteFeedback(id: string): Promise<void>;
  deleteAllFeedbacks(projectName: string): Promise<void>;
  /** Post a reply on a feedback's thread — idempotent on `input.clientId`, so a resend never duplicates it. */
  addComment(feedbackId: string, input: CommentCreateInput): Promise<CommentResponse>;
}

/**
 * Options accepted by `WidgetClient.getFeedbacks` — core's `FeedbackQuery`
 * minus the `projectName` the client already knows. Derived, so a new query
 * filter added to core flows to both the HTTP and store clients
 * automatically.
 */
export type GetFeedbacksOptions = Prettify<Omit<FeedbackQuery, "projectName">>;

/** Auth options for `ApiClient` / `flushRetryQueue` (HTTP mode). */
export interface ApiClientAuth {
  /** Sent as `Authorization: Bearer <apiKey>` on every request. */
  apiKey?: string | undefined;
  /** Extra headers, static or per-request factory. An explicit `Authorization` entry wins over `apiKey`. */
  headers?: SitepingHeadersOption | undefined;
}

const MAX_RETRIES = 3;
const TIMEOUT_MS = 10_000;
/**
 * Longest `Retry-After` waited out while a call is in flight (the popup holds
 * the visitor meanwhile). A longer one ends the retries at once: a send is
 * queued for the next page load, a read or a reply reports its error.
 */
const MAX_RETRY_AFTER_MS = 10_000;
/**
 * A project delete can legitimately run long — an issue tracker closing each
 * issue, a screenshot store emptying its objects (#413) — so it gets its own
 * window, and is never sent again after it: the server may still be running
 * the first request.
 */
const DELETE_ALL_TIMEOUT_MS = 60_000;
/** localStorage key of the queue earlier widgets kept (still read, see `offline-queue.ts`). */
const RETRY_QUEUE_KEY = "siteping_retry_queue";
/** localStorage flag: the IndexedDB outbox holds entries — a page load replays them. */
const OUTBOX_FLAG_KEY = "siteping_outbox";

/**
 * Settle like `promise`, or reject with `onTimeout()` once `ms` elapse; the
 * timer is cleared either way. The underlying work is not cancelled — use it
 * where nothing can abort the call (a store write, a host headers factory).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Build the headers for one request: `Content-Type` when the request
 * carries a JSON body, then `Bearer` from `apiKey`, then `headers` merged on
 * top case-insensitively, so an explicit `Authorization` in any casing wins.
 *
 * A function `headers` resolves once per call — retries inside
 * `resilientFetch` reuse the values for the whole retry sequence. A factory
 * that throws, rejects, or does not settle within 10 s fails the request
 * like a network error — nothing may hold a send forever.
 */
export async function buildRequestHeaders(auth: ApiClientAuth, json: boolean): Promise<Record<string, string>> {
  const defaults: Record<string, string> = {};
  if (json) defaults["Content-Type"] = "application/json";
  if (auth.apiKey) defaults.Authorization = `Bearer ${auth.apiKey}`;
  const extra =
    typeof auth.headers === "function"
      ? await withTimeout(
          Promise.resolve(auth.headers()),
          TIMEOUT_MS,
          () => new Error(`headers factory did not settle within ${TIMEOUT_MS / 1000} s`),
        )
      : auth.headers;
  return mergeRequestHeaders(defaults, extra);
}

// ---------------------------------------------------------------------------
// Core fetch with retry + exponential backoff + jitter
// ---------------------------------------------------------------------------

/**
 * One HTTP call with retry + exponential backoff + jitter: each attempt is
 * aborted if its headers take more than TIMEOUT_MS. Network failures and
 * transient statuses (5xx, 408, 429) retry, after the response's
 * `Retry-After` when it sets one; the final response is read through
 * `errorFromResponse` for a non-OK status, `read` for a 2xx.
 *
 * With `boundBody` (the send path, #342), the body gets its own TIMEOUT_MS
 * window under the same abort, so one that stalls after the headers errors
 * instead of holding the popup forever — a non-OK status still maps to its
 * typed error, just without the server's detail. Reads leave it unbounded:
 * a page of inline screenshots can legitimately take longer on a slow link.
 *
 * `timeoutMs` widens each attempt's window, and `resendOnTimeout: false`
 * stops at an attempt that timed out instead of sending it again: a request
 * the server may still be running must not start twice. Network failures
 * before an answer and transient statuses keep their retries.
 *
 * Failures come out typed: a non-OK status as `errorFromResponse` maps it,
 * anything else (fetch, abort, body read or parse) as a `SitepingNetworkError`.
 */
async function resilientFetch<T>(
  url: string,
  init: RequestInit,
  label: string,
  read: (response: Response) => Promise<T>,
  { boundBody = false, timeoutMs = TIMEOUT_MS, resendOnTimeout = true } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), timeoutMs);
    let delay: number;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal }).catch((error: unknown) => {
        if (attempt === MAX_RETRIES || (!resendOnTimeout && controller.signal.aborted)) {
          throw networkErrorFromException(error, label);
        }
        return null;
      });
      delay = retryDelay(response, attempt);
      // A non-transient status is the server's answer (a 2xx, or a verdict
      // like a 400) — final, like the last attempt or a wait too long to hold.
      if (response && (!isTransientStatus(response.status) || attempt === MAX_RETRIES || delay > MAX_RETRY_AFTER_MS)) {
        clearTimeout(timeout);
        if (boundBody) timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        if (!response.ok) throw await errorFromResponse(response, label);
        return await read(response).catch((error: unknown) => {
          throw networkErrorFromException(error, label);
        });
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Wait before retrying a failed attempt: the response's `Retry-After`
 * (delta-seconds or an HTTP date) when it holds a valid one, otherwise
 * exponential backoff with jitter — 1 s, 2 s, 4 s, ±500 ms.
 */
function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get("Retry-After");
  const wait = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : Number.NaN;
  return Number.isNaN(wait) ? 1000 * 2 ** attempt + Math.random() * 1000 - 500 : Math.max(0, wait);
}

// ---------------------------------------------------------------------------
// Offline queue — a lazy chunk (`offline-queue.ts`); only its entry points here
// ---------------------------------------------------------------------------

/**
 * Whether a failed submission is worth replaying later. Network failures,
 * server errors (5xx), timeouts (408) and rate limits (429) are transient —
 * the same payload can succeed once the server is back or has waited. Any
 * other 4xx is the server's verdict on the payload itself (validation, auth,
 * size…): replaying it verbatim fails identically every time, so it is
 * surfaced to the host through `onError` and never queued — a queued
 * rejection used to be replayed, and rejected, on every page load.
 */
function isTransientFailure(error: unknown): error is SitepingError {
  return error instanceof SitepingNetworkError || (error instanceof SitepingError && error.code === "SERVER");
}

/** Same verdict from a status: retried in flight, kept queued for the next flush — the rest is final. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

type OfflineQueue = typeof import("./offline-queue.js");
let offlineQueue: OfflineQueue | null = null;

function loadOfflineQueue(): Promise<OfflineQueue> {
  return import("./offline-queue.js").then((module) => {
    module.configureOfflineQueue({
      retryQueueKey: RETRY_QUEUE_KEY,
      outboxFlagKey: OUTBOX_FLAG_KEY,
      timeoutMs: TIMEOUT_MS,
      buildRequestHeaders,
      isTransientStatus,
      markOwn: (projectName, endpoint, id) => ownFeedback(projectName, endpoint).add(id),
    });
    offlineQueue = module;
    return module;
  });
}

/**
 * Failed sends kept while the queue's own code could not load — offline
 * before the chunk was ever fetched. Handed to the queue on the next flush.
 */
const stash: Array<[endpoint: string, payload: FeedbackPayload, recording: PendingRecording | undefined]> = [];

/** Queue a failed send (see `enqueue` in `offline-queue.ts`), or stash it when the chunk will not load. */
async function queueFailedSend(endpoint: string, payload: FeedbackPayload, recording?: PendingRecording) {
  try {
    return await (await loadOfflineQueue()).enqueue(endpoint, payload, recording);
  } catch {
    stash.push([endpoint, payload, recording]);
    return true;
  }
}

/**
 * Fetch the queue's code ahead of need: a send that fails offline could not
 * download it then. The launcher calls it once the page is idle (HTTP mode).
 */
export function preloadOfflineQueue(): void {
  loadOfflineQueue().catch(() => {});
}

/** Whether anything may wait in a queue: a stored one, or this page's memory. Cheap — no IndexedDB. */
export function hasQueuedFeedback(): boolean {
  if (stash.length > 0 || offlineQueue?.hasMemoryEntries()) return true;
  try {
    return localStorage.getItem(RETRY_QUEUE_KEY) !== null || localStorage.getItem(OUTBOX_FLAG_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether a failed send was saved for a replay: `true` queued, `false` worth
 * queueing but no storage would hold it, absent when the failure is final (a
 * 4xx) or did not come from `sendFeedback`. The widget tells the visitor
 * which one happened.
 */
const queueOutcomes = new WeakMap<object, boolean>();

export function queueOutcome(error: unknown): boolean | undefined {
  return typeof error === "object" && error !== null ? queueOutcomes.get(error) : undefined;
}

/**
 * Replay what the queues hold for `endpoint` (see `flush` in
 * `offline-queue.ts`) — on load and when the browser comes back online.
 * Loads the queue's code only when something may be pending. Resolves how
 * many feedbacks were sent.
 */
export async function flushRetryQueue(
  endpoint: string,
  currentIdentity?: SitepingIdentity | null,
  auth: ApiClientAuth = {},
): Promise<number> {
  if (!hasQueuedFeedback()) return 0;
  const queue = await loadOfflineQueue();
  for (const [stashedEndpoint, payload, recording] of stash.splice(0)) {
    await queue.enqueue(stashedEndpoint, payload, recording);
  }
  return queue.flush(endpoint, currentIdentity, auth);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/** The span `[start, start + size]` intersected with [0, 1], as `[start, size]`; one already inside comes back as is. */
function clipSpan(start: number, size: number): [number, number] {
  const from = Math.min(1, Math.max(0, start));
  const trimmed = size - (from - start);
  return [from, Math.max(0, from + trimmed <= 1 ? trimmed : 1 - from)];
}

/**
 * The annotation with its rect intersected with the anchor box: the server
 * schema rejects any rect field outside [0, 1], and the `document.body`
 * fallback anchor may not contain a rect drawn in blank page space (a short
 * body, its default margin). A rect fully outside collapses onto the nearest
 * edge rather than losing the feedback. Store mode has no such schema and
 * keeps the rect as drawn — markers extrapolate past the anchor box.
 */
function clipRectToAnchor(annotation: AnnotationPayload): AnnotationPayload {
  const [xPct, wPct] = clipSpan(annotation.rect.xPct, annotation.rect.wPct);
  const [yPct, hPct] = clipSpan(annotation.rect.yPct, annotation.rect.hPct);
  return { ...annotation, rect: { xPct, yPct, wPct, hPct } };
}

/** Parse a JSON body and assert its TypeScript shape — server-side Zod is the source of truth. */
async function parseJsonAs<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** DELETE responses carry nothing the client needs. */
async function ignoreBody(): Promise<void> {}

export class ApiClient implements WidgetClient {
  /** Whether the console already explained a refused list (see `getFeedbacks`). */
  private listRefusalExplained = false;

  constructor(
    private readonly endpoint: string,
    private readonly projectName: string,
    private readonly auth: ApiClientAuth = {},
  ) {}

  /** `buildRequestHeaders`, with a failing headers factory normalised to a `SitepingNetworkError`. */
  private async headers(json: boolean, label: string): Promise<Record<string, string>> {
    try {
      return await buildRequestHeaders(this.auth, json);
    } catch (error) {
      throw networkErrorFromException(error, label);
    }
  }

  async sendFeedback(payload: FeedbackPayload, recording?: PendingRecording): Promise<FeedbackResponse> {
    const label = "Failed to send feedback";
    // Only put `screenshotRegion` on the wire when a region was actually
    // captured — servers that predate the field would otherwise reject an
    // explicit `screenshotRegion: null` on every legacy capture.
    const { screenshotRegion, ...rest } = payload;
    const wire = { ...rest, annotations: rest.annotations.map(clipRectToAnchor) };
    let body: FeedbackPayload = screenshotRegion ? { ...wire, screenshotRegion } : wire;
    if (recording) {
      try {
        const { uploadRecording } = await import("./recording-upload.js");
        const headers = await this.headers(false, "Failed to upload the screen recording");
        const info = await uploadRecording(this.endpoint, body.projectName, body.clientId, recording, headers);
        body = { ...body, diagnostics: { ...(body.diagnostics ?? { console: [], network: [] }), recording: info } };
      } catch (error) {
        // Offline or the server down: queue the feedback with its video, to
        // upload both on the replay. Refused (too large…): send it without.
        if (isTransientFailure(error)) {
          queueOutcomes.set(error, await queueFailedSend(this.endpoint, body, recording));
          throw error;
        }
        console.warn("[siteping] the screen recording was refused; the feedback is sent without it:", error);
      }
    }
    try {
      const created = await resilientFetch(
        this.endpoint,
        { method: "POST", headers: await this.headers(true, label), body: JSON.stringify(body) },
        label,
        parseJsonAs<FeedbackResponse>,
        { boundBody: true },
      );
      // A resend that lands drops the attempt an earlier failure queued.
      if (hasQueuedFeedback()) void loadOfflineQueue().then((queue) => queue.dequeue(body.clientId));
      return created;
    } catch (error) {
      // Queue the wire shape (region stripped when absent) so a later
      // flushRetryQueue replays exactly what a fresh POST would send — but
      // only when a replay can succeed (see `isTransientFailure`).
      if (isTransientFailure(error)) {
        queueOutcomes.set(error, await queueFailedSend(this.endpoint, body));
      }
      throw error;
    }
  }

  async getFeedbacks(projectName: string, options?: GetFeedbacksOptions): Promise<FeedbackResponseList> {
    const label = "Failed to fetch feedbacks";
    const params = feedbackQueryToSearchParams({ projectName, ...options });
    // GET carries no body — only attach headers when auth produced some, so
    // the no-auth wire shape stays byte-identical to the legacy client.
    const headers = await this.headers(false, label);
    return resilientFetch(
      withSearchParams(this.endpoint, params),
      { method: "GET", cache: "no-store", ...(Object.keys(headers).length > 0 ? { headers } : {}) },
      label,
      parseJsonAs<FeedbackResponseList>,
    ).catch((error: unknown) => {
      // With an `apiKey`, the server keeps GET behind it by default (#280): a
      // key-less widget submits fine but never shows a pin, with nothing on
      // screen to say why. Say it in the console, once per client.
      if (error instanceof SitepingAuthError && !this.listRefusalExplained) {
        this.listRefusalExplained = true;
        console.warn(
          `[siteping] Feedback list refused (${error.status}): with an apiKey, GET needs it unless publicEndpoints includes "GET"; pins and panel stay empty. https://siteping.dev/docs/server#the-security-model-honestly`,
        );
      }
      throw error;
    });
  }

  async addComment(feedbackId: string, input: CommentCreateInput): Promise<CommentResponse> {
    const label = "Failed to post comment";
    // The same endpoint as a feedback: `feedbackId` routes the POST to the
    // thread. Retries resend the same clientId, which the server dedupes.
    return resilientFetch(
      this.endpoint,
      {
        method: "POST",
        headers: await this.headers(true, label),
        body: JSON.stringify({ ...input, projectName: this.projectName, feedbackId }),
      },
      label,
      parseJsonAs<CommentResponse>,
      { boundBody: true },
    );
  }

  async resolveFeedback(id: string, resolved: boolean): Promise<FeedbackResponse> {
    const label = "Failed to update feedback";
    return resilientFetch(
      this.endpoint,
      {
        method: "PATCH",
        headers: await this.headers(true, label),
        body: JSON.stringify({ id, projectName: this.projectName, status: resolved ? "resolved" : "open" }),
      },
      label,
      parseJsonAs<FeedbackResponse>,
    );
  }

  async deleteFeedback(id: string): Promise<void> {
    const label = "Failed to delete feedback";
    await resilientFetch(
      this.endpoint,
      {
        method: "DELETE",
        headers: await this.headers(true, label),
        body: JSON.stringify({ id, projectName: this.projectName }),
      },
      label,
      ignoreBody,
    );
  }

  async deleteAllFeedbacks(projectName: string): Promise<void> {
    const label = "Failed to delete all feedbacks";
    await resilientFetch(
      this.endpoint,
      {
        method: "DELETE",
        headers: await this.headers(true, label),
        body: JSON.stringify({ projectName, deleteAll: true }),
      },
      label,
      ignoreBody,
      { timeoutMs: DELETE_ALL_TIMEOUT_MS, resendOnTimeout: false },
    );
  }
}
