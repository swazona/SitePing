/**
 * Offline queue — feedbacks whose send failed on a network error or a
 * transient status (5xx, 408, 429), kept on the device and replayed when the
 * browser comes back online (`online`) and on the next page load.
 *
 * Loaded on demand (`api-client.ts` imports it only when a send fails, or
 * when something is pending): a visitor whose sends land never downloads it.
 *
 * Where an entry goes, first that works:
 *
 * 1. **IndexedDB** — room for screenshots and screen recordings (stored as
 *    `Blob`s), out of the host page's ~5 MB localStorage budget.
 * 2. **localStorage** — the queue earlier widgets wrote (`siteping_retry_queue`),
 *    still read and replayed, so an upgrade loses nothing. Used for new
 *    entries only without IndexedDB (private modes that block it), and never
 *    for a recording, which it cannot hold.
 * 3. **Memory** — for the page's lifetime: replayed on `online`, lost on reload.
 *
 * Every queue is keyed by `clientId`: a resend replaces its earlier attempt,
 * and the server stores a replay of a feedback that did land only once (it is
 * idempotent on `clientId`). At most {@link MAX_QUEUE_SIZE} feedbacks and
 * {@link MAX_QUEUED_RECORDINGS} recordings are kept, the oldest dropped first.
 * Cross-tab access is serialized with a Web Lock.
 */

import { type FeedbackPayload, hasOwn, type RecordingInfo, SitepingError, type SitepingIdentity } from "@siteping/core";
import type { ApiClientAuth } from "./api-client.js";
import { type PendingRecording, uploadRecording } from "./recording-upload.js";

/**
 * What the queue borrows from the HTTP client — handed over by `api-client.ts`
 * when it loads this chunk ({@link configureOfflineQueue}), rather than
 * imported: a static import would pull the client out of the first-load
 * bundle into a shared chunk.
 */
export interface OfflineQueueDeps {
  /** localStorage key of the queue earlier widgets kept. */
  retryQueueKey: string;
  /** localStorage flag: IndexedDB holds entries. */
  outboxFlagKey: string;
  /** Each replay's window, in ms. */
  timeoutMs: number;
  buildRequestHeaders(auth: ApiClientAuth, json: boolean): Promise<Record<string, string>>;
  isTransientStatus(status: number): boolean;
  /** Record a replayed feedback as sent from this browser (the panel's "Mine"). */
  markOwn(projectName: string, endpoint: string, id: string): void;
}

let deps: OfflineQueueDeps;

/** Called once by `api-client.ts` as it loads the chunk. */
export function configureOfflineQueue(value: OfflineQueueDeps): void {
  deps = value;
}

/** Most feedbacks kept, in each store. */
export const MAX_QUEUE_SIZE = 20;
/** Most recordings kept (each up to several MB); older entries keep their feedback, not their video. */
export const MAX_QUEUED_RECORDINGS = 3;

const LOCK_NAME = "siteping_retry_queue";
const DB_NAME = "siteping";
const DB_STORE = "outbox";

export interface RetryEntry {
  endpoint: string;
  payload: FeedbackPayload;
  /** The screen recording to upload before the payload (IndexedDB and memory only). */
  recording?: PendingRecording | undefined;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Acquire a Web Lock to serialize cross-tab access to the retry queue.
 * Falls back to running the callback without locking on older browsers.
 */
async function withRetryLock<T>(callback: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, () => callback());
  }
  return callback();
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** One place entries live: read them all, or replace them all (under the lock). */
interface QueueStore {
  read(): Promise<RetryEntry[]>;
  /** Replace the contents; resolves false when the write did not land. */
  write(entries: RetryEntry[]): Promise<boolean>;
}

/** Remember in localStorage whether IndexedDB holds entries, so a page load opens it only then. */
function setOutboxFlag(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(deps.outboxFlagKey, "1");
    else localStorage.removeItem(deps.outboxFlagKey);
  } catch {
    // No flag: the next load just doesn't look (the `online` replay still does).
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) {
          request.result.createObjectStore(DB_STORE, { keyPath: "payload.clientId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const indexedDbStore: QueueStore = {
  async read() {
    const db = await openDb();
    if (!db) return [];
    try {
      const all = await idbRequest(db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll());
      return (all as unknown[]).filter(isRetryEntry);
    } catch {
      return [];
    }
  },
  async write(entries) {
    const db = await openDb();
    if (!db) return false;
    try {
      const transaction = db.transaction(DB_STORE, "readwrite");
      const store = transaction.objectStore(DB_STORE);
      store.clear();
      for (const entry of entries) store.put(entry);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      setOutboxFlag(entries.length > 0);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Shape-check one queue element — storage can hold tampered or legacy
 * entries, and a malformed one used to abort the whole flush via the outer
 * catch. Bad entries are dropped individually instead. The author fields are
 * checked because the flush itself reads them (identity match); anything
 * else wrong with a payload is the server's verdict (4xx → dropped).
 */
function isRetryEntry(value: unknown): value is RetryEntry {
  if (!hasOwn(value, "endpoint") || typeof value.endpoint !== "string" || !hasOwn(value, "payload")) return false;
  const { payload } = value;
  return (
    hasOwn(payload, "authorName") &&
    typeof payload.authorName === "string" &&
    hasOwn(payload, "authorEmail") &&
    typeof payload.authorEmail === "string"
  );
}

function readLocalQueue(): RetryEntry[] {
  const raw = localStorage.getItem(deps.retryQueueKey);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The widget only ever writes JSON.stringify output here, so an external
    // writer put this value in place. Nothing in it can be replayed; clear it
    // so the queue works again instead of every write failing on this parse.
    localStorage.removeItem(deps.retryQueueKey);
    console.warn(`[siteping] discarded an unreadable retry queue from localStorage (${raw.length} chars)`);
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isRetryEntry) : [];
}

function tryWriteLocalQueue(queue: RetryEntry[]): boolean {
  try {
    if (queue.length > 0) localStorage.setItem(deps.retryQueueKey, JSON.stringify(queue));
    else localStorage.removeItem(deps.retryQueueKey);
    return true;
  } catch {
    return false;
  }
}

const localStorageStore: QueueStore = {
  async read() {
    try {
      return readLocalQueue();
    } catch {
      return [];
    }
  },
  async write(entries) {
    return tryWriteLocalQueue(entries);
  },
};

let memory: RetryEntry[] = [];

const memoryStore: QueueStore = {
  async read() {
    return memory.slice();
  },
  async write(entries) {
    memory = entries.slice();
    return true;
  },
};

/** @internal — tests: forget this page's memory queue and the IndexedDB handle. */
export function _resetOfflineQueueForTests(): void {
  memory = [];
  dbPromise = null;
}

/** Whether this page holds entries only memory kept — the `online` replay has work even without a stored flag. */
export function hasMemoryEntries(): boolean {
  return memory.length > 0;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

function hasScreenshot(entry: RetryEntry): boolean {
  return entry.payload.screenshotDataUrl != null;
}

/** Replay copy without the screenshot; its region is meaningless without the image. */
function withoutScreenshot(entry: RetryEntry): RetryEntry {
  const { screenshotDataUrl: _screenshotDataUrl, screenshotRegion: _screenshotRegion, ...payload } = entry.payload;
  return { ...entry, payload };
}

function withoutRecording(entry: RetryEntry): RetryEntry {
  const { recording: _recording, ...rest } = entry;
  return rest;
}

/**
 * `queue` with `entry` in place of any earlier attempt of its clientId, at
 * most `MAX_QUEUE_SIZE` long (oldest dropped) and `MAX_QUEUED_RECORDINGS`
 * recordings (the oldest lose theirs).
 */
function admit(queue: RetryEntry[], entry: RetryEntry): RetryEntry[] {
  // A resend from the same popup reuses its clientId: replace the earlier
  // attempt so the replay carries the latest edit (the server's clientId
  // dedupe would otherwise keep the stale first one).
  const next = queue.filter((queued) => queued.payload.clientId !== entry.payload.clientId);
  // Cap queue size to prevent unbounded growth
  while (next.length >= MAX_QUEUE_SIZE) next.shift();
  next.push(entry);
  let recordings = next.filter((queued) => queued.recording).length;
  for (let index = 0; recordings > MAX_QUEUED_RECORDINGS && index < next.length; index++) {
    const queued = next[index];
    if (queued?.recording) {
      next[index] = withoutRecording(queued);
      recordings -= 1;
    }
  }
  return next;
}

/**
 * Keep `queue` in localStorage. Quota exceeded: screenshots (base64 JPEG
 * data URLs) dominate each entry, and up to MAX_QUEUE_SIZE entries share the
 * origin's ~5 MB localStorage budget with the host page. Shed screenshots
 * (the heaviest, least essential part of a replay) one at a time, oldest
 * first like the eviction above, so no more are lost than the quota
 * requires; the message, annotations and diagnostics still replay. If even
 * the screenshot-free queue does not fit, evict the oldest entries.
 */
function writeLocalQueueShedding(queue: RetryEntry[]): boolean {
  if (tryWriteLocalQueue(queue)) return true;
  const kept = queue.slice();
  let stripped = 0;
  for (const [index, entry] of kept.entries()) {
    if (!hasScreenshot(entry)) continue;
    kept[index] = withoutScreenshot(entry);
    stripped += 1;
    if (tryWriteLocalQueue(kept)) {
      console.warn(
        `[siteping] retry queue exceeded the localStorage quota — dropped the screenshot of ${stripped} of ${queue.length} queued feedback(s)`,
      );
      return true;
    }
  }
  while (kept.length > 1) {
    kept.shift();
    if (tryWriteLocalQueue(kept)) {
      const dropped = queue.length - kept.length;
      const lost = queue.slice(dropped).filter(hasScreenshot).length;
      console.warn(
        `[siteping] retry queue exceeded the localStorage quota — dropped the ${dropped} oldest of ${queue.length} queued feedback(s)${lost > 0 ? `, and the screenshot of ${lost} of the rest` : ""}`,
      );
      return true;
    }
  }
  return false;
}

/**
 * Queue a failed send for a replay. Resolves whether it was kept — in
 * IndexedDB, localStorage or (for this page only) memory, the first that
 * works; `false` only when nothing could hold it.
 */
export function enqueue(endpoint: string, payload: FeedbackPayload, recording?: PendingRecording): Promise<boolean> {
  const entry: RetryEntry = { endpoint, payload, ...(recording ? { recording } : {}) };
  return withRetryLock(async () => {
    if (await indexedDbStore.write(admit(await indexedDbStore.read(), entry))) return true;
    if (!recording) {
      try {
        if (writeLocalQueueShedding(admit(readLocalQueue(), entry))) return true;
        // Every write failed, so the queue already stored is left as it was.
        console.warn("[siteping] feedback could not be queued in localStorage — keeping it for this page only");
      } catch {
        // localStorage unavailable — memory below
      }
    }
    memory = admit(memory, entry);
    return true;
  }).catch(() => false);
}

/**
 * Drop the queued attempt of a feedback that has just landed (a resend from
 * the same popup, same clientId), so the next page load does not re-POST a
 * payload of up to ~1.5 MB only for the server to dedupe it.
 */
export function dequeue(clientId: string): Promise<void> {
  return withRetryLock(async () => {
    for (const store of [indexedDbStore, localStorageStore, memoryStore]) {
      const queue = await store.read();
      const remaining = queue.filter((entry) => entry.payload.clientId !== clientId);
      if (remaining.length !== queue.length) await store.write(remaining);
    }
  }).catch(() => {
    // A replay of the queued copy is deduped server-side
  });
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function normalizeName(value: string): string {
  return value.trim();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

type ReplayOutcome = "sent" | "failed" | "rejected";

/**
 * Upload a queued recording, then attach it to the payload. A transient
 * failure keeps the whole entry queued; a final one (the server refused the
 * video) sends the feedback without it.
 */
async function withUploadedRecording(
  entry: RetryEntry,
  auth: ApiClientAuth,
): Promise<{ payload: FeedbackPayload } | "failed"> {
  if (!entry.recording) return { payload: entry.payload };
  let recording: RecordingInfo;
  try {
    recording = await uploadRecording(
      entry.endpoint,
      entry.payload.projectName,
      entry.payload.clientId,
      entry.recording,
      await deps.buildRequestHeaders(auth, false),
    );
  } catch (error) {
    if (!(error instanceof SitepingError) || error.retryable) return "failed";
    console.warn("[siteping] the server refused a queued screen recording; its feedback is sent without it");
    return { payload: entry.payload };
  }
  const diagnostics = entry.payload.diagnostics ?? { console: [], network: [] };
  return { payload: { ...entry.payload, diagnostics: { ...diagnostics, recording } } };
}

async function replay(entry: RetryEntry, headers: Record<string, string>, auth: ApiClientAuth): Promise<ReplayOutcome> {
  const prepared = await withUploadedRecording(entry, auth);
  if (prepared === "failed") return "failed";
  // Same bound as a live send's attempt: the replay holds the cross-tab
  // lock, so one that never answers would block every later queueing on
  // this origin.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(entry.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(prepared.payload),
      signal: controller.signal,
    });
    if (res.ok) {
      // Sent from this browser after all: the panel's "Mine" filter lists it
      const created: unknown = await res.json().catch(() => null);
      if (hasOwn(created, "id") && typeof created.id === "string") {
        deps.markOwn(entry.payload.projectName, entry.endpoint, created.id);
      }
      return "sent";
    }
    return deps.isTransientStatus(res.status) ? "failed" : "rejected";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Flush queued feedbacks for `endpoint`, from every store. When
 * `currentIdentity` is provided, entries whose stored author doesn't match it
 * are dropped rather than replayed. This prevents user A's offline feedback
 * from being POSTed under user B's identity after a session change. When
 * omitted, all entries are replayed.
 *
 * `auth` headers resolve fresh at flush time (once per flush call) — queue
 * entries persist payloads only, never headers or token material.
 *
 * Resolves how many queued feedbacks were sent.
 */
export async function flush(
  endpoint: string,
  currentIdentity?: SitepingIdentity | null,
  auth: ApiClientAuth = {},
): Promise<number> {
  return withRetryLock(async () => {
    let sent = 0;
    let headers: Record<string, string> | null = null;
    for (const store of [indexedDbStore, localStorageStore, memoryStore]) {
      try {
        const queue = await store.read();
        if (queue.length === 0) continue;

        const toRetry: RetryEntry[] = [];
        const unrelated: RetryEntry[] = [];
        let dropped = 0;
        for (const entry of queue) {
          if (entry.endpoint !== endpoint) {
            unrelated.push(entry);
            continue;
          }
          if (
            !currentIdentity ||
            (normalizeName(entry.payload.authorName) === normalizeName(currentIdentity.name) &&
              normalizeEmail(entry.payload.authorEmail) === normalizeEmail(currentIdentity.email))
          ) {
            toRetry.push(entry);
          } else {
            dropped += 1;
          }
        }
        if (toRetry.length === 0 && dropped === 0) continue;
        if (dropped > 0) {
          console.debug("[siteping] flushRetryQueue: dropped", dropped, "stale entries (identity changed)");
        }

        // Process items sequentially to avoid overwhelming the server
        const failed: RetryEntry[] = [];
        let rejected = 0;
        if (toRetry.length > 0) {
          headers ??= await deps.buildRequestHeaders(auth, true);
          for (const entry of toRetry) {
            const outcome = await replay(entry, headers, auth);
            if (outcome === "sent") sent += 1;
            else if (outcome === "failed") failed.push(entry);
            else rejected += 1;
          }
        }
        if (rejected > 0) {
          console.warn(
            `[siteping] flushRetryQueue: dropped ${rejected} queued feedback(s) the server rejected (4xx) — they would fail identically on every replay`,
          );
        }
        // Rebuild queue: keep unrelated entries + failed retries
        await store.write(unrelated.concat(failed));
      } catch {
        // Ignore — this storage may be unavailable
      }
    }
    return sent;
  });
}
