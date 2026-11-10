/**
 * Upload of a screen recording to the endpoint, before the feedback that
 * names it (see `RecordingStorage` in core): a `POST` whose body is the
 * video itself, `?projectName=…&clientId=…`, answered `201 { url }`.
 *
 * A separate request rather than a field of the feedback's JSON: a minute of
 * video weighs megabytes, past the JSON body limit, and base64 would add a
 * third. Only sent to a server that advertises `capabilities.recordings`.
 */

import {
  errorFromResponse,
  hasOwn,
  networkErrorFromException,
  type RecordingInfo,
  SitepingNetworkError,
  withSearchParams,
} from "@siteping/core";

/** A finished recording waiting to be uploaded. */
export interface PendingRecording {
  blob: Blob;
  /** The media type without codecs: `video/webm` or `video/mp4`. */
  mimeType: RecordingInfo["mimeType"];
  durationMs: number;
}

/** Each attempt's window — a few MB on a slow uplink take a while. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Upload `recording` and resolve what the feedback's `diagnostics.recording`
 * carries, with the request's auth `headers` (no `Content-Type`). Fails
 * with a typed `SitepingError`: retryable for a network failure or a
 * transient status, final for the server's refusal (413, 415…).
 */
export async function uploadRecording(
  endpoint: string,
  projectName: string,
  clientId: string,
  recording: PendingRecording,
  headers: Record<string, string>,
): Promise<RecordingInfo> {
  const label = "Failed to upload the screen recording";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(withSearchParams(endpoint, new URLSearchParams({ projectName, clientId })), {
      method: "POST",
      headers: { ...headers, "Content-Type": recording.mimeType },
      body: recording.blob,
      signal: controller.signal,
    }).catch((error: unknown) => {
      throw networkErrorFromException(error, label);
    });
    if (!response.ok) throw await errorFromResponse(response, label);
    const body: unknown = await response.json().catch(() => null);
    if (!hasOwn(body, "url") || typeof body.url !== "string") throw new SitepingNetworkError(label);
    return {
      url: body.url,
      mimeType: recording.mimeType,
      durationMs: Math.round(recording.durationMs),
      bytes: recording.blob.size,
    };
  } finally {
    clearTimeout(timeout);
  }
}
