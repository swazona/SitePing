import { type RecordingStorage, sniffRecordingMimeType } from "@siteping/core";
import { ERROR_MESSAGES } from "../constants.js";
import { requestMediaType } from "../csrf.js";
import type { SitepingHandlerBaseOptions } from "../options.js";
import { type Pipeline, readBytes } from "../pipeline.js";
import { recordingUploadQuerySchema } from "../validation.js";

/** Media types the recording upload takes — the body is the video itself. */
export const RECORDING_UPLOAD_MEDIA_TYPES: ReadonlyArray<string> = ["video/webm", "video/mp4"];

/** Whether a POST is a recording upload rather than a JSON feedback or comment. */
export function isRecordingUpload(request: Request): boolean {
  return requestMediaType(request).startsWith("video/");
}

interface UploadRecordingDependencies<Principal> {
  pipeline: Pipeline<Principal>;
  recordingStorage: RecordingStorage | undefined;
  maxRecordingBytes: number;
  beforeUpload: SitepingHandlerBaseOptions<Principal>["beforeRecordingUpload"];
}

/**
 * `POST` with a video body — store a screen recording through
 * `recordingStorage`, before the feedback that names it is sent. The bytes
 * must really be WebM or MP4, whatever `Content-Type` claims; then
 * `beforeRecordingUpload` may pin the target (as `beforeCreate` does for a
 * feedback), and the same access rule as a create applies (`action:
 * "create"`) to the project it returns, which the upload is stored under.
 * Answers `201 { url }`; 415 without a `recordingStorage`, 413 past
 * `maxRecordingBytes`.
 */
export function uploadRecordingOperation<Principal>({
  pipeline,
  recordingStorage,
  maxRecordingBytes,
  beforeUpload,
}: UploadRecordingDependencies<Principal>) {
  return async (request: Request): Promise<Response> => {
    const entry = await pipeline.enter(request, "POST", RECORDING_UPLOAD_MEDIA_TYPES);
    if (!entry.ok) return entry.response;
    const scope = entry.value;
    if (!recordingStorage || !RECORDING_UPLOAD_MEDIA_TYPES.includes(requestMediaType(request))) {
      return pipeline.error(scope, 415, ERROR_MESSAGES.unsupportedMediaType);
    }

    const searchParams = new URL(request.url).searchParams;
    const query = pipeline.validate(scope, recordingUploadQuerySchema, {
      projectName: searchParams.get("projectName") ?? undefined,
      clientId: searchParams.get("clientId") ?? undefined,
    });
    if (!query.ok) return query.response;

    try {
      // Read (capped) before the hook, which is told the file's type and size
      // — as a JSON create is parsed before `beforeCreate`.
      const bytes = await readBytes(request, maxRecordingBytes).catch(() => new Uint8Array(0));
      if (bytes === null) return pipeline.error(scope, 413, ERROR_MESSAGES.bodyTooLarge);
      const mimeType = sniffRecordingMimeType(bytes);
      if (!mimeType) return pipeline.error(scope, 400, ERROR_MESSAGES.invalidRecording);
      // The hook decides the target (the project from the session, say), and
      // the authorization and the storage both see what it returned.
      const target = beforeUpload
        ? await beforeUpload({ ...query.value, mimeType, size: bytes.byteLength }, scope.context)
        : query.value;
      const projectName: unknown = target?.projectName;
      const clientId: unknown = target?.clientId;
      if (typeof projectName !== "string" || typeof clientId !== "string") {
        throw new TypeError("beforeRecordingUpload must return { projectName, clientId }");
      }
      const refusal = await pipeline.authorize(scope, { action: "create", projectName });
      if (refusal) return refusal;
      const { url } = await recordingStorage.upload(bytes, { mimeType, projectName, clientId });
      return pipeline.json(scope, { url }, { status: 201 });
    } catch (error) {
      return pipeline.fail(scope, "[siteping] Failed to store a recording", error);
    }
  };
}
