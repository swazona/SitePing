import {
  formatFeedbackReport,
  REPORT_SECTIONS,
  type RedactableField,
  type ReportFormat,
  type ReportSection,
} from "@siteping/core/report";
import type { ReactElement, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EXPORT_CSS } from "../export-styles.js";
import { getTypeLabel, type TranslationKey, tWithParams } from "../i18n/index.js";
import type { InboxRecord } from "../types.js";
import { trapTab, useInboxUi } from "./context.js";
import { CloseIcon } from "./icons.js";

interface ExportDialogProps {
  /** One record (the drawer's), or the loaded list to pick from. */
  records: readonly InboxRecord[];
  /** Pick from `records` (checkboxes) — the toolbar's export of the list. */
  multiple: boolean;
  onClose: () => void;
}

const FORMATS: ReadonlyArray<{
  format: ReportFormat;
  label: TranslationKey | null;
  name: string;
  ext: string;
  mime: string;
}> = [
  { format: "markdown", label: null, name: "Markdown", ext: "md", mime: "text/markdown" },
  { format: "text", label: "export.formatText", name: "", ext: "txt", mime: "text/plain" },
  { format: "prompt", label: "export.formatPrompt", name: "", ext: "md", mime: "text/markdown" },
  { format: "json", label: null, name: "JSON", ext: "json", mime: "application/json" },
];

/** Redaction toggles: the pattern-based ones, then the field ones (author names covers the thread's too). */
type RedactToggle = "secrets" | "emails" | "queryStrings" | "authorName" | "userAgent";
const REDACT_TOGGLES: readonly RedactToggle[] = ["secrets", "emails", "queryStrings", "authorName", "userAgent"];
const FIELDS_OF: Partial<Record<RedactToggle, RedactableField[]>> = {
  authorName: ["authorName", "commentAuthors"],
  userAgent: ["userAgent"],
};

const STYLE_ID = "siteping-inbox-export-styles";

function ensureExportStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = EXPORT_CSS;
  document.head.appendChild(style);
}

function excerpt(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Export dialog: a report of one feedback or of a selection, in Markdown,
 * plain text, an AI prompt or JSON (core's `formatFeedbackReport`), with
 * sections and redaction to choose, copied or downloaded. Loaded on demand —
 * the inbox's first load carries only the buttons that open it.
 *
 * Modal like the shortcuts overlay: focus is trapped, Esc closes, and no key
 * reaches the inbox's shortcuts behind it.
 */
export function ExportDialog({ records, multiple, onClose }: ExportDialogProps): ReactElement {
  const { t, notify } = useInboxUi();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLTextAreaElement | null>(null);
  const [format, setFormat] = useState<ReportFormat>("markdown");
  const [sections, setSections] = useState<ReadonlySet<ReportSection>>(() => new Set(REPORT_SECTIONS));
  const [redact, setRedact] = useState<ReadonlySet<RedactToggle>>(() => new Set<RedactToggle>(["secrets"]));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(records.map((record) => record.id)));

  useEffect(() => {
    ensureExportStyles();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const chosen = useMemo(
    () => (multiple ? records.filter((record) => selected.has(record.id)) : records),
    [records, selected, multiple],
  );
  const output = useMemo(() => {
    if (chosen.length === 0) return "";
    return formatFeedbackReport(multiple ? chosen : (chosen[0] as InboxRecord), {
      format,
      sections: Object.fromEntries(REPORT_SECTIONS.map((section) => [section, sections.has(section)])),
      redact: {
        secrets: redact.has("secrets"),
        emails: redact.has("emails"),
        queryStrings: redact.has("queryStrings"),
        fields: [...redact].flatMap((toggle) => FIELDS_OF[toggle] ?? []),
      },
    });
  }, [chosen, multiple, format, sections, redact]);

  const toggle = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const current = FORMATS.find((entry) => entry.format === format) ?? FORMATS[0];
  const fileName = (): string => {
    const base = multiple ? `siteping-${chosen.length}-feedbacks` : `siteping-${chosen[0]?.id ?? "feedback"}`;
    return `${base}${format === "prompt" ? "-prompt" : ""}.${current?.ext ?? "txt"}`;
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(output);
      notify(t("inbox.copied"));
    } catch {
      // Write blocked (permission, insecure context): select the preview so a Ctrl+C still works.
      previewRef.current?.focus();
      previewRef.current?.select();
    }
  };

  const download = (): void => {
    const blob = new Blob([output], { type: `${current?.mime ?? "text/plain"};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName();
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here reaches the inbox's shortcuts (j/k, e, Esc closing the drawer…).
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab" && rootRef.current) trapTab(event, rootRef.current);
  };

  const allSelected = selected.size === records.length;

  return (
    <div
      ref={rootRef}
      className="spd-export"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="spd-export-card">
        <div className="spd-export-head">
          <h2 id={titleId} className="spd-export-title">
            {t("export.title")}
          </h2>
          <button type="button" className="spd-icon-btn" aria-label={t("shortcuts.close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="spd-export-body">
          <div className="spd-export-options">
            <fieldset className="spd-export-group">
              <legend className="spd-meta-label">{t("export.format")}</legend>
              {FORMATS.map((entry) => (
                <label key={entry.format} className="spd-export-check">
                  <input
                    type="radio"
                    name={`${titleId}-format`}
                    value={entry.format}
                    checked={format === entry.format}
                    onChange={() => setFormat(entry.format)}
                  />
                  {entry.label ? t(entry.label) : entry.name}
                </label>
              ))}
            </fieldset>
            <fieldset className="spd-export-group">
              <legend className="spd-meta-label">{t("export.sections")}</legend>
              {REPORT_SECTIONS.map((section) => (
                <label key={section} className="spd-export-check">
                  <input
                    type="checkbox"
                    checked={sections.has(section)}
                    onChange={() => setSections((set) => toggle(set, section))}
                  />
                  {t(`export.section.${section}`)}
                </label>
              ))}
            </fieldset>
            <fieldset className="spd-export-group">
              <legend className="spd-meta-label">{t("export.redact")}</legend>
              {REDACT_TOGGLES.map((key) => (
                <label key={key} className="spd-export-check">
                  <input
                    type="checkbox"
                    checked={redact.has(key)}
                    onChange={() => setRedact((set) => toggle(set, key))}
                  />
                  {t(`export.redact.${key}`)}
                </label>
              ))}
            </fieldset>
            {multiple ? (
              <fieldset className="spd-export-group spd-export-picks">
                <legend className="spd-meta-label">
                  {tWithParams(t, "export.selectedCount", { count: selected.size })}
                </legend>
                <label className="spd-export-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(records.map((record) => record.id)))}
                  />
                  {t("export.selectAll")}
                </label>
                {records.map((record) => (
                  <label key={record.id} className="spd-export-check" title={record.message}>
                    <input
                      type="checkbox"
                      checked={selected.has(record.id)}
                      onChange={() => setSelected((set) => toggle(set, record.id))}
                    />
                    <span className="spd-export-pick">
                      <i className="spd-type-square" data-type={record.type} aria-hidden="true" />
                      <span className="spd-sr-only">{getTypeLabel(record.type, t)}: </span>
                      {excerpt(record.message)}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          <textarea
            ref={previewRef}
            className="spd-export-preview"
            aria-label={t("export.preview")}
            readOnly
            value={chosen.length === 0 ? t("export.nothingSelected") : output}
          />
        </div>
        <div className="spd-export-foot">
          <button
            type="button"
            className="spd-btn"
            disabled={chosen.length === 0}
            onClick={() => {
              void copy();
            }}
          >
            {t("export.copy")}
          </button>
          <button type="button" className="spd-btn-primary" disabled={chosen.length === 0} onClick={download}>
            {t("export.download")}
          </button>
        </div>
      </div>
    </div>
  );
}
