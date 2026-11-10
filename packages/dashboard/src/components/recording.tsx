import type { DiagnosticsSnapshot } from "@siteping/core";
import type { ReactElement } from "react";
import { lazy, Suspense, useId } from "react";
import { safeRecording } from "../format.js";
import { useInboxUi } from "./context.js";

// The player — <video>, its details, its styles — loads with the first
// recording opened, so the inbox's first load carries only this section.
const RecordingPlayer = lazy(() =>
  import("./recording-player.js").then((module) => ({ default: module.RecordingPlayer })),
);

interface RecordingSectionProps {
  diagnostics: Pick<DiagnosticsSnapshot, "recording"> | null;
}

/**
 * The drawer's "Screen recording" section: the player when the feedback has
 * a recording at an http(s) URL, a plain line otherwise — none, or a link
 * the inbox refuses to load (`safeRecording`).
 */
export function RecordingSection({ diagnostics }: RecordingSectionProps): ReactElement {
  const { t, locale } = useInboxUi();
  const recording = safeRecording(diagnostics);
  const titleId = useId();
  return (
    <section className="spd-recording" aria-labelledby={titleId}>
      <h3 id={titleId} className="spd-meta-label">
        {t("recording.title")}
      </h3>
      {recording === "none" || recording === "unsafe" ? (
        <p className="spd-recording-empty" data-state={recording}>
          {t(recording === "none" ? "recording.none" : "recording.unsafe")}
        </p>
      ) : (
        <Suspense fallback={<div className="spd-recording-placeholder" aria-hidden="true" />}>
          <RecordingPlayer
            recording={recording}
            locale={locale}
            labels={{
              player: t("recording.player"),
              download: t("recording.download"),
              playbackError: t("recording.playbackError"),
              duration: t("recording.duration"),
              size: t("recording.size"),
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
