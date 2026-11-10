import {
  type FeedbackRecord,
  type FeedbackStatus,
  type FeedbackUpdateInput,
  isClosedStatus,
  isStoreNotFound,
  toFeedbackUpdate,
} from "@siteping/core";
import { DEFAULT_WEBHOOK_MAX_BODY_BYTES, WEBHOOK_RESPONSES } from "../constants/webhooks.js";
import { parseIssueMarker } from "./issue-format.js";
import type { IssueReference, TrackedIssue } from "./issue-tracker.js";
import { checkPositiveInteger } from "./tracker-options.js";

/**
 * The slice of a `SitepingStore` the webhooks write through — any store
 * fits. With `getFeedback`, a delivery reads the feedback's status first
 * and leaves alone a status the issue's state already agrees with.
 */
export interface IssueWebhookStore {
  updateFeedback(id: string, data: FeedbackUpdateInput): Promise<FeedbackRecord>;
  verifyProjectOwnership(id: string, projectName: string): Promise<boolean>;
  getFeedback?(id: string): Promise<FeedbackRecord | null>;
}

/** A feedback status a tracker webhook changed. */
export interface IssueStatusSync {
  /** The tracker's name: `GitHub`, `Linear`, `Jira`, `Plane`, `ClickUp`. */
  tracker: string;
  issue: IssueReference;
  /** The status before, when the store could read it (`getFeedback`). */
  previousStatus: FeedbackStatus | null;
  status: FeedbackStatus;
}

/** Options every tracker webhook handler takes. */
export interface IssueWebhookOptions {
  /** The webhook's signing secret, as configured on the tracker. */
  secret: string;
  /** Where feedbacks live — the store your `createSitepingHandler` uses. */
  store: IssueWebhookStore;
  /**
   * The `instance` of the `createIssueTrackerHooks` that opened the issues:
   * a delivery about an issue of another deployment is ignored.
   */
  instance?: string | undefined;
  /**
   * Called with each feedback a delivery changed — e.g. the server's
   * `notifyReporter`, which these writes do not go through. A throw is
   * logged; the delivery still succeeds, the write having happened.
   */
  onStatusSynced?: ((feedback: FeedbackRecord, sync: IssueStatusSync) => void | Promise<void>) | undefined;
  /** Where failures are reported. Defaults to `console.error`. */
  logger?: { error(message: string, context?: Record<string, unknown>): unknown } | undefined;
  /** Largest delivery accepted, in bytes. Defaults to 5 MiB; a larger one answers 413. */
  maxBodyBytes?: number | undefined;
}

/** What a provider hands the shared handler. */
export interface WebhookProvider {
  tracker: string;
  factory: string;
  /** Whether the delivery is authentic, from its raw bytes and headers. */
  verify(request: Request, body: Uint8Array): Promise<boolean>;
  /**
   * The issue a delivery is about, as it now is, or `null` when the
   * delivery is not an issue closing or reopening (another event, another
   * repository, an issue without the `siteping` label…).
   */
  issueOf(payload: unknown, request: Request): Promise<TrackedIssue | null>;
}

type WebhookResult = { result: "updated"; status: FeedbackStatus } | { result: "ignored"; reason: string };

const encoder = new TextEncoder();

/** Hex HMAC-SHA256 of `body` with `secret`, on Web Crypto (any runtime). */
export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare two strings in time that depends on their length only. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** Whether `signature` (hex, any case) is the HMAC-SHA256 of `body`. */
export async function verifyHexSignature(secret: string, body: Uint8Array, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  return timingSafeEqual(await hmacSha256Hex(secret, body), signature.trim().toLowerCase());
}

/** The request body's bytes, or `null` past `maxBytes` — counted as they stream in. */
async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("Content-Length")) > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The secret, checked when the handler is created: an empty one would accept any delivery signed with it. */
export function checkSecret(factory: string, secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(`[siteping] ${factory}: secret must be a non-empty string`);
  }
}

/**
 * The status the issue's state asks for, or `null` when the feedback
 * already agrees: an open issue leaves an open feedback (`open` or
 * `in_progress`) alone, a closed one a closed feedback unless the tracker
 * says why it closed and that reason differs.
 */
function targetStatus(issue: TrackedIssue, current: FeedbackStatus | null): FeedbackStatus | null {
  if (issue.isOpen) return current !== null && !isClosedStatus(current) ? null : "open";
  if (current !== null && isClosedStatus(current)) {
    return issue.closedAs !== undefined && issue.closedAs !== current ? issue.closedAs : null;
  }
  return issue.closedAs ?? "resolved";
}

/**
 * A Fetch API handler (`Request` → `Response`) applying a tracker's
 * deliveries to the store. Answers 401 on a bad signature, 400 on a body
 * that is not JSON, 413 past `maxBodyBytes`, 500 when the store fails (the
 * tracker retries), and 200 otherwise, with `{ result: "updated" }` or
 * `{ result: "ignored", reason }`.
 */
export function createWebhookHandler(
  provider: WebhookProvider,
  { secret, store, instance: instanceName, onStatusSynced, logger = console, maxBodyBytes }: IssueWebhookOptions,
): (request: Request) => Promise<Response> {
  checkSecret(provider.factory, secret);
  checkPositiveInteger(provider.factory, "maxBodyBytes", maxBodyBytes);
  if (!store || typeof store.updateFeedback !== "function" || typeof store.verifyProjectOwnership !== "function") {
    throw new Error(`[siteping] ${provider.factory}: store must implement updateFeedback and verifyProjectOwnership`);
  }
  const limit = maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const instance = instanceName || undefined;
  const ignored = (reason: string): WebhookResult => ({ result: "ignored", reason });

  const apply = async (issue: TrackedIssue): Promise<WebhookResult> => {
    const link = parseIssueMarker(issue.body);
    if (!link) return ignored(WEBHOOK_RESPONSES.notLinked);
    if (link.instance !== instance) return ignored(WEBHOOK_RESPONSES.otherInstance);
    // The marker names the project too: a feedback id from another project's issue is not this one.
    if (!(await store.verifyProjectOwnership(link.feedbackId, link.projectName))) {
      return ignored(WEBHOOK_RESPONSES.feedbackNotFound);
    }
    const previousStatus = store.getFeedback ? ((await store.getFeedback(link.feedbackId))?.status ?? null) : null;
    const status = targetStatus(issue, previousStatus);
    if (status === null) return ignored(WEBHOOK_RESPONSES.alreadyInSync);
    let feedback: FeedbackRecord;
    try {
      feedback = await store.updateFeedback(link.feedbackId, toFeedbackUpdate(status));
    } catch (error) {
      // Deleted in between.
      if (isStoreNotFound(error)) return ignored(WEBHOOK_RESPONSES.feedbackNotFound);
      throw error;
    }
    try {
      await onStatusSynced?.(feedback, { tracker: provider.tracker, issue: issue.reference, previousStatus, status });
    } catch (error) {
      logger.error(`[siteping] ${provider.tracker} webhook: onStatusSynced failed`, {
        error,
        feedbackId: feedback.id,
        projectName: feedback.projectName,
      });
    }
    return { result: "updated", status };
  };

  return async (request) => {
    if (request.method !== "POST") {
      return Response.json({ error: WEBHOOK_RESPONSES.methodNotAllowed }, { status: 405, headers: { Allow: "POST" } });
    }
    const body = await readBytes(request, limit).catch(() => new Uint8Array());
    if (body === null) return Response.json({ error: WEBHOOK_RESPONSES.bodyTooLarge }, { status: 413 });
    if (!(await provider.verify(request, body))) {
      return Response.json({ error: WEBHOOK_RESPONSES.invalidSignature }, { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return Response.json({ error: WEBHOOK_RESPONSES.invalidJson }, { status: 400 });
    }
    try {
      const issue = await provider.issueOf(payload, request);
      return Response.json(issue ? await apply(issue) : ignored(WEBHOOK_RESPONSES.notAStateChange));
    } catch (error) {
      logger.error(`[siteping] ${provider.tracker} webhook failed`, { error });
      return Response.json({ error: WEBHOOK_RESPONSES.failed }, { status: 500 });
    }
  };
}

/** `value` as a plain object, or an empty one — for reading untrusted payloads. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
