/**
 * Screen recording — the browser's screen-sharing prompt
 * (`getDisplayMedia`), then a `MediaRecorder` capture up to a duration and a
 * size, with a recording indicator and its Stop button on screen.
 *
 * Loaded on demand (the launcher imports it when "Record screen" is picked):
 * a chunk of its own.
 *
 * `preferCurrentTab` asks Chromium to offer the current tab first, which is
 * what a feedback is about; other browsers ignore the member. The recording
 * also stops when the visitor ends the share from the browser's own UI.
 */

import type { TFunction } from "./i18n/index.js";
import type { PendingRecording } from "./recording-upload.js";
import type { ThemeColors } from "./styles/theme.js";
import type { SurfaceKit } from "./surface-kit.js";

/** Container types tried in order; the first the browser records is used. */
const CANDIDATE_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
/** ~6 MB a minute: legible UI at a modest size. */
const VIDEO_BITS_PER_SECOND = 800_000;
/** A chunk a second, so the size limit is checked as the recording grows. */
const TIMESLICE_MS = 1000;

export interface RecordScreenOptions {
  maxDurationMs: number;
  maxBytes: number;
  colors: ThemeColors;
  t: TFunction;
  kit: SurfaceKit;
}

/** `m:ss` of a duration. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The form's name for an attached recording: "Recording (0:12)". */
export function recordingLabel(t: TFunction, durationMs: number): string {
  return t("popup.recording").replace("{duration}", formatDuration(durationMs));
}

/** The first candidate container the browser can record, or "" to let it choose. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string {
  return CANDIDATE_TYPES.find((type) => isTypeSupported(type)) ?? "";
}

/** The media type a recording is uploaded as, codecs dropped: `video/mp4` or `video/webm`. */
export function baseMimeType(type: string): PendingRecording["mimeType"] {
  return type.toLowerCase().startsWith("video/mp4") ? "video/mp4" : "video/webm";
}

/**
 * The recording indicator: a dark pill at the bottom centre of the viewport
 * (inline-axis centred, so it stays put in RTL), outside the captures
 * (`data-siteping-ignore`).
 */
function buildIndicator(colors: ThemeColors, t: TFunction, kit: SurfaceKit, onStop: () => void) {
  const { el, setText, focusRing, pressable, isolateFromHost } = kit;
  const root = el("div", {
    style: /* css */ `
      position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:${kit.zIndex};
      display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;
      border-radius:9999px;background:rgba(0,0,0,0.86);color:#f5f5f7;
      font-family:${kit.font};font-size:14px;font-variant-numeric:tabular-nums;
      box-shadow:0 8px 24px rgba(0,0,0,0.3);
    `,
  });
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", t("fab.record"));
  root.setAttribute("data-siteping-ignore", "true");
  root.setAttribute("data-siteping-recording", "");
  const dot = el("span", {
    style: "width:10px;height:10px;border-radius:50%;background:#ff3b30;flex-shrink:0;",
    "aria-hidden": "true",
  });
  const time = el("span", {});
  const stop = document.createElement("button");
  stop.type = "button";
  stop.style.cssText = /* css */ `
    min-height:32px;padding:0 14px;border:none;border-radius:9999px;cursor:pointer;
    background:${colors.accent};color:#fff;font-family:${kit.font};font-size:14px;font-weight:600;
  `;
  setText(stop, t("record.stop"));
  stop.addEventListener("click", onStop);
  pressable(stop);
  focusRing(stop, colors.accent);
  root.append(dot, time, stop);
  isolateFromHost(root);
  document.body.appendChild(root);
  return {
    update(elapsedMs: number) {
      setText(time, t("record.status").replace("{time}", formatDuration(elapsedMs)));
    },
    focus() {
      stop.focus({ preventScroll: true });
    },
    remove() {
      root.remove();
    },
  };
}

/**
 * Ask to share the screen and record until Stop, the duration or the size
 * limit, or the end of the share. Resolves the recording, or `null` when the
 * visitor declines the prompt or nothing was recorded; rejects when the
 * browser cannot record.
 */
export async function recordScreen({
  maxDurationMs,
  maxBytes,
  colors,
  t,
  kit,
}: RecordScreenOptions): Promise<PendingRecording | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
  } catch (error) {
    // The visitor dismissed the prompt (or a policy denied it): not a failure.
    if (error instanceof DOMException && error.name === "NotAllowedError") return null;
    throw error;
  }

  const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const chunks: Blob[] = [];
  let bytes = 0;
  const startedAt = performance.now();
  const returnFocus = document.activeElement as HTMLElement | null;

  return new Promise((resolve, reject) => {
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    const indicator = buildIndicator(colors, t, kit, stop);
    indicator.update(0);
    indicator.focus();
    const ticker = setInterval(() => indicator.update(performance.now() - startedAt), 500);
    const limit = setTimeout(stop, maxDurationMs);
    for (const track of stream.getTracks()) track.addEventListener("ended", stop);

    const finish = () => {
      clearInterval(ticker);
      clearTimeout(limit);
      for (const track of stream.getTracks()) track.stop();
      indicator.remove();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      // A chunk lands each second: stop one second's worth early, so the last
      // one still fits under the limit.
      if (bytes + VIDEO_BITS_PER_SECOND / 8 >= maxBytes) stop();
    });
    recorder.addEventListener("stop", () => {
      finish();
      const type = baseMimeType(recorder.mimeType || mimeType);
      const blob = new Blob(chunks, { type });
      resolve(blob.size > 0 ? { blob, mimeType: type, durationMs: performance.now() - startedAt } : null);
    });
    recorder.addEventListener("error", (event) => {
      finish();
      reject((event as ErrorEvent).error ?? new Error("[siteping] screen recording failed"));
    });
    recorder.start(TIMESLICE_MS);
  });
}
