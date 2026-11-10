import type { ReactElement } from "react";
import { useInsertionEffect, useState } from "react";
import type { SafeRecording } from "../format.js";
import { formatBytes, formatClock } from "../media-format.js";
import { RECORDING_CSS } from "../recording-styles.js";

/** Arrow into a tray — the icon set's frame (see icons.tsx), kept here so it loads with the player. */
function DownloadIcon(): ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M2.5 13.5h11" />
    </svg>
  );
}

const STYLE_ID = "siteping-inbox-recording-styles";

function ensureRecordingStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = RECORDING_CSS;
  document.head.appendChild(style);
}

/** The player's strings, translated by the section that loads it. */
export interface RecordingPlayerLabels {
  player: string;
  download: string;
  playbackError: string;
  duration: string;
  size: string;
}

interface RecordingPlayerProps {
  /** Checked by `safeRecording`: the URL is an absolute http(s) one. */
  recording: SafeRecording;
  labels: RecordingPlayerLabels;
  /** Intl-valid locale, for the file size. */
  locale: string;
}

/**
 * Native player for a feedback's screen recording, with its length, size
 * and a download link. Loaded on demand (see `RecordingSection`). The video
 * fetches only its metadata until played; when the browser cannot decode it
 * (a WebM in an older Safari), the player gives way to the download link.
 * It takes its strings as props rather than from the inbox context, so its
 * chunk imports nothing but React — no shared chunk split off the first load.
 */
export function RecordingPlayer({ recording, labels, locale }: RecordingPlayerProps): ReactElement {
  const [failed, setFailed] = useState(false);
  useInsertionEffect(ensureRecordingStyles, []);

  return (
    <div className="spd-player">
      {failed ? (
        <p className="spd-recording-empty" role="status">
          {labels.playbackError}
        </p>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: a screen recording has no audio track to caption
        <video
          className="spd-player-video"
          controls
          preload="metadata"
          playsInline
          aria-label={labels.player}
          onError={() => setFailed(true)}
        >
          <source
            src={recording.url}
            {...(recording.mimeType ? { type: recording.mimeType } : {})}
            onError={() => setFailed(true)}
          />
        </video>
      )}
      <div className="spd-player-meta">
        <dl className="spd-player-facts">
          {recording.durationMs !== null ? (
            <div>
              <dt>{labels.duration}</dt>
              <dd>{formatClock(recording.durationMs)}</dd>
            </div>
          ) : null}
          {recording.bytes !== null ? (
            <div>
              <dt>{labels.size}</dt>
              <dd>{formatBytes(recording.bytes, locale)}</dd>
            </div>
          ) : null}
        </dl>
        <a
          className="spd-btn spd-player-download"
          href={recording.url}
          download
          target="_blank"
          rel="noreferrer"
          referrerPolicy="no-referrer"
        >
          <DownloadIcon />
          {labels.download}
        </a>
      </div>
    </div>
  );
}
