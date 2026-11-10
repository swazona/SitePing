import type { RecordingInfo } from "./types.js";

/**
 * Pluggable storage for screen recordings, the video counterpart of
 * {@link ScreenshotStorage}.
 *
 * A screenshot travels inline in the feedback's JSON (a data URL of about a
 * megabyte at most). A recording does not fit there: a minute of screen
 * video weighs several megabytes, past the JSON body limit. The widget
 * uploads it on its own first — a `POST` to the same endpoint whose body is
 * the video itself (`Content-Type: video/webm` or `video/mp4`) — and the
 * server hands the bytes to `upload`. The feedback sent next carries the URL
 * returned, in `diagnostics.recording`; the server keeps it only when
 * `isOwnUrl` recognises it, so a client cannot attach any URL it likes.
 *
 * Configure it on `createSitepingHandler({ recordingStorage })`; the list
 * responses then advertise `capabilities.recordings`, which is what makes
 * the widget offer "Record screen". Without it, nothing changes.
 *
 * @example
 * ```ts
 * import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
 *
 * const s3 = new S3Client({ region: "eu-west-3" });
 * const base = "https://cdn.example.com/";
 * const recordingStorage: RecordingStorage = {
 *   async upload(bytes, { mimeType }) {
 *     const key = `siteping-recordings/${crypto.randomUUID()}`; // fresh per upload
 *     await s3.send(new PutObjectCommand({ Bucket: "my-bucket", Key: key, Body: bytes, ContentType: mimeType }));
 *     return { url: `${base}${key}` };
 *   },
 *   isOwnUrl: (url) => url.startsWith(`${base}siteping-recordings/`),
 * };
 * ```
 */
export interface RecordingStorage {
  /**
   * Persist one recording and return the URL a reviewer opens it at. The
   * bytes were checked to be a WebM or MP4 file of at most the server's
   * `maxRecordingBytes`. Key each upload by a fresh random value: the URL
   * is the only thing that ties a recording to its feedback.
   *
   * `ctx.projectName` is the project the upload was authorized for, and
   * `ctx.clientId` the idempotency key of the feedback it will join (both
   * client-supplied, validated as an identifier: sanitize them before using
   * them in a path).
   */
  upload(
    bytes: Uint8Array<ArrayBuffer>,
    ctx: { mimeType: RecordingInfo["mimeType"]; projectName: string; clientId: string },
  ): Promise<{ url: string }>;
  /** Whether `url` is one `upload` returned — a feedback naming any other recording URL loses it. */
  isOwnUrl(url: string): boolean;
}

/** Media types a recording upload may declare. */
export const RECORDING_MIME_TYPES = ["video/webm", "video/mp4"] as const satisfies ReadonlyArray<
  RecordingInfo["mimeType"]
>;

/**
 * The media type `bytes` actually holds, from its first bytes: WebM (an EBML
 * header) or MP4 (an `ftyp` box), `null` for anything else — a declared
 * `Content-Type` is the client's claim, the magic bytes are not.
 */
export function sniffRecordingMimeType(bytes: Uint8Array): RecordingInfo["mimeType"] | null {
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  return null;
}
