import { parseHttpUrl } from "@siteping/core";
import { NotificationDeliveryError } from "./errors.js";

/** Longest `Retry-After` honoured, in ms: past it, the dispatcher's own cap applies. */
const RETRY_AFTER_MAX_MS = 60_000;

/**
 * `value` as an https URL — or plain http on this machine, for a local
 * receiver in development. Checked once, when the channel is built: a
 * destination only ever comes from the server's configuration.
 *
 * @throws Error naming the option, never its value (it may carry a token).
 */
export function destinationUrl(factory: string, option: string, value: unknown): URL {
  const url = typeof value === "string" ? parseHttpUrl(value) : null;
  if (!url || (url.protocol === "http:" && !isLoopback(url.hostname))) {
    throw new Error(`[siteping] ${factory}: \`${option}\` must be an absolute https URL (http only on localhost)`);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/** `Retry-After` in ms: seconds, or an HTTP date. */
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : undefined;
}

/** 408, 425, 429 and 5xx are worth another attempt; any other refusal is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface PostOptions {
  channel: string;
  url: URL;
  body: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal: AbortSignal;
  /** The outlet's error description, read from a failed response's body. */
  describe?: ((body: string) => { detail?: string | undefined; retryAfterMs?: number | undefined }) | undefined;
}

/**
 * POST `body` and resolve with the response text when the outlet accepts
 * it — a redirect counts as a refusal, never followed. A failure throws a {@link NotificationDeliveryError} that names
 * neither the URL nor the network error (which may name the URL): only
 * the error's `name` (`TimeoutError`, `AbortError`, `TypeError`) is kept.
 */
export async function post({ channel, url, body, headers, fetch, signal, describe }: PostOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal, redirect: "manual" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    throw new NotificationDeliveryError(channel, `request failed (${name})`);
  }
  const text = await response.text().catch(() => "");
  if (response.ok) return text;
  const described = describe?.(text) ?? {};
  const after = described.retryAfterMs ?? retryAfter(response);
  throw new NotificationDeliveryError(channel, `request failed with status ${response.status}`, {
    status: response.status,
    retryable: isRetryableStatus(response.status),
    ...(after === undefined ? {} : { retryAfterMs: after }),
    ...(described.detail === undefined ? {} : { detail: described.detail }),
  });
}

/** A JSON body's `description`-like field, when there is one. */
export function jsonField(text: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}
