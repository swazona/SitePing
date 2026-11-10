/**
 * The detail view's component path and screen recording rows. Imported by
 * the panel only, so it ships in the lazily loaded panel chunk rather than
 * with `panel-detail.ts`, which the shadow stylesheet pulls into the first
 * load (its CSS, `.sp-detail-meta-link`, lives in `DETAIL_CSS`).
 */

import { type FeedbackResponse, parseHttpUrl } from "@siteping/core";
import { el, setText } from "./dom-utils.js";
import type { TFunction } from "./i18n/index.js";
import { type DetailMetaRow, ICON_CODE } from "./panel-detail.js";

const ICON_VIDEO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>`;

/** Over this many names, a path folds its middle to "…". */
const FOLD_OVER = 4;

/**
 * The React component path, root first, as one line: "App › Layout › Form".
 * Over four names, the middle folds to "…" — the root and the nearest
 * components are what a developer searches for; the full path is the
 * row's title. Null when the feedback has none.
 */
export function componentPathText(
  diagnostics: FeedbackResponse["diagnostics"],
): { short: string; full: string } | null {
  const names = (Array.isArray(diagnostics?.components) ? diagnostics.components : []).filter(
    (name): name is string => typeof name === "string" && name.trim() !== "",
  );
  if (names.length === 0) return null;
  const shown = names.length > FOLD_OVER ? [names[0], "…", ...names.slice(-2)] : names;
  return { short: shown.join(" › "), full: names.join(" › ") };
}

/**
 * The recording's URL when it is an absolute http(s) one, else null — a
 * store can hold any string there, and a `javascript:` URL must never
 * become a link in the panel.
 */
export function recordingHref(diagnostics: FeedbackResponse["diagnostics"]): string | null {
  const url: unknown = diagnostics?.recording?.url;
  return typeof url === "string" ? (parseHttpUrl(url)?.href ?? null) : null;
}

/**
 * The rows for `DetailCallbacks.mediaRows`: the component path when
 * captured, and a link to the recording (opened in a new tab, so the panel
 * carries no player) when it has an http(s) URL.
 */
export function mediaRows(feedback: FeedbackResponse, t: TFunction): DetailMetaRow[] {
  const rows: DetailMetaRow[] = [];
  const path = componentPathText(feedback.diagnostics);
  if (path) {
    const value = el("div", { class: "sp-detail-meta-value sp-detail-meta-value--mono" });
    setText(value, path.short);
    value.title = path.full;
    rows.push({ icon: ICON_CODE, label: t("detail.component"), value });
  }
  const href = recordingHref(feedback.diagnostics);
  if (href) {
    const value = el("div", { class: "sp-detail-meta-value" });
    const link = document.createElement("a");
    link.className = "sp-detail-meta-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const ms = feedback.diagnostics?.recording?.durationMs;
    const seconds = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
    const label = t("detail.watchRecording");
    setText(
      link,
      seconds === null ? label : `${label} (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`,
    );
    value.appendChild(link);
    rows.push({ icon: ICON_VIDEO, label: t("detail.recording"), value });
  }
  return rows;
}
