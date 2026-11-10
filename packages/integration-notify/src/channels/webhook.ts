/**
 * A generic webhook: the message as JSON, signed with HMAC-SHA256 — for
 * n8n, Zapier, Make, your own service, or (with `body`) Discord, Microsoft
 * Teams and anything else that takes a JSON POST.
 *
 * Headers:
 * - `X-Siteping-Timestamp`: Unix time of the attempt, in seconds;
 * - `X-Siteping-Signature`: `sha256=` + hex HMAC-SHA256 of
 *   `<timestamp>.<raw body>` under the shared secret;
 * - `X-Siteping-Event`: the event; `X-Siteping-Delivery`: an id the
 *   retries of one notification share, to deduplicate on.
 *
 * Verify with {@link verifyNotificationSignature} (constant-time, through
 * Web Crypto), over the raw body bytes, before parsing it.
 */
import type { NotificationChannel, NotificationMessage } from "../core/channel.js";
import { NotificationDeliveryError } from "../core/errors.js";
import { destinationUrl, post } from "../core/http.js";

/** What the default body carries. */
export interface NotificationWebhookPayload {
  type: "siteping.notification";
  version: 1;
  /** Same as the `X-Siteping-Delivery` header. */
  deliveryId: string;
  message: NotificationMessage;
}

export interface WebhookChannelOptions {
  /** Where to POST — from your configuration only. https (http on localhost). */
  url: string;
  /** The shared signing secret, at least 32 characters — read it from the environment. */
  secret: string;
  /**
   * The JSON body, for receivers with their own format (Discord's
   * `{ content }`, a Teams card). Defaults to a {@link NotificationWebhookPayload}.
   * Its texts are the message's: plain, unescaped and visitor-controlled —
   * escape them for the receiver, and turn its mentions off.
   */
  body?: ((message: NotificationMessage) => unknown) | undefined;
  /** Extra static headers, e.g. an `Authorization` the receiver expects. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** Names the channel in logs and results. Defaults to `webhook`. */
  name?: string | undefined;
  fetch?: typeof fetch | undefined;
}

const SIGNATURE_PREFIX = "sha256=";
const MIN_SECRET_LENGTH = 32;
/** Default clock skew accepted by the verifier, in seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedBytes(timestamp: string, body: string | Uint8Array): Uint8Array {
  const head = encoder.encode(`${timestamp}.`);
  const tail = typeof body === "string" ? encoder.encode(body) : body;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

/** The `X-Siteping-Signature` value for `body` sent at `timestamp` (Unix seconds, as sent). */
export async function signNotification(secret: string, timestamp: string, body: string | Uint8Array): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return SIGNATURE_PREFIX + toHex(await crypto.subtle.sign("HMAC", key, signedBytes(timestamp, body) as BufferSource));
}

export interface NotificationSignatureInput {
  secret: string;
  /** The raw body, exactly as received — not re-serialized JSON. */
  body: string | Uint8Array;
  /** The `X-Siteping-Signature` header. */
  signature: string | null | undefined;
  /** The `X-Siteping-Timestamp` header. */
  timestamp: string | null | undefined;
  /** Largest clock skew accepted, in seconds — older deliveries are replays. Defaults to 300. */
  toleranceSeconds?: number | undefined;
  /** Current time in ms. Defaults to `Date.now()`. */
  now?: number | undefined;
}

/**
 * Whether a delivery is authentic and fresh. The HMAC comparison is
 * Web Crypto's `verify`, which takes constant time: never compare
 * signatures with `===`.
 */
export async function verifyNotificationSignature(input: NotificationSignatureInput): Promise<boolean> {
  const { secret, body, signature, timestamp, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = input;
  if (!secret || !signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const hex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, bytes, signedBytes(timestamp, body) as BufferSource);
}

/** Headers a configured `headers` option may not override. */
const RESERVED_HEADERS = new Set([
  "content-type",
  "x-siteping-signature",
  "x-siteping-timestamp",
  "x-siteping-event",
  "x-siteping-delivery",
]);

/** The id the retries of `message` share: its event, feedback and time. */
function deliveryIdOf(message: NotificationMessage): string {
  return `${message.event}:${message.feedbackId}:${message.occurredAt}`.replace(/[^\w:.-]/g, "");
}

/**
 * A channel POSTing each notification, signed, to `url`.
 *
 * @throws Error for a non-https `url`, a secret shorter than 32
 * characters, or a header that is reserved or carries a line break.
 */
export function createWebhookChannel(options: WebhookChannelOptions): NotificationChannel {
  const url = destinationUrl("createWebhookChannel", "url", options.url);
  if (typeof options.secret !== "string" || options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`[siteping] createWebhookChannel: \`secret\` must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const extra: Record<string, string> = {};
  for (const [header, value] of Object.entries(options.headers ?? {})) {
    if (
      RESERVED_HEADERS.has(header.toLowerCase()) ||
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(header) ||
      /[\r\n\0]/.test(value)
    ) {
      throw new Error(`[siteping] createWebhookChannel: header "${header}" is reserved or malformed`);
    }
    extra[header] = value;
  }
  const { secret } = options;
  const name = options.name ?? "webhook";
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    name,
    async send(message, { signal }) {
      const deliveryId = deliveryIdOf(message);
      let body: string;
      try {
        const payload: unknown = options.body
          ? options.body(message)
          : ({ type: "siteping.notification", version: 1, deliveryId, message } satisfies NotificationWebhookPayload);
        body = JSON.stringify(payload);
      } catch (error) {
        throw new NotificationDeliveryError(name, `body failed (${error instanceof Error ? error.name : "Error"})`, {
          retryable: false,
        });
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      await post({
        channel: name,
        url,
        body,
        headers: {
          ...extra,
          "Content-Type": "application/json",
          "X-Siteping-Event": message.event,
          "X-Siteping-Delivery": deliveryId,
          "X-Siteping-Timestamp": timestamp,
          "X-Siteping-Signature": await signNotification(secret, timestamp, body),
        },
        fetch: fetchImplementation,
        signal,
        // No `detail`: an arbitrary receiver may echo the request, its headers included.
      });
    },
  };
}
