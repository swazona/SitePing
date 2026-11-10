/**
 * Plain-text hygiene shared by the message builder and every channel.
 * Everything a notification quotes comes from a visitor: the channels
 * clean it again (a message may be built by hand or by `formatMessage`)
 * before escaping it for their outlet and cutting it to its limits.
 */
import { createReportRedactor } from "@siteping/core/report";

/** Line terminators normalized to `\n`, invisible and bidirectional control characters out — no pattern redaction. */
const normalize = createReportRedactor({ secrets: false }).text;

const ELLIPSIS = "…";

/** `value` on one line: every line break and whitespace run a single space, invisible characters out. */
export function oneLine(value: string): string {
  return normalize(value).replace(/\s+/g, " ").trim();
}

/** `value` as a text block: line breaks kept as `\n` (at most one blank line in a row), invisible characters out. */
export function textBlock(value: string): string {
  return normalize(value)
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `value` cut to at most `max` UTF-16 code units — what Slack, Telegram and
 * WhatsApp count — with an ellipsis when cut, never inside a surrogate pair.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max - ELLIPSIS.length) break;
    out += char;
  }
  return out + ELLIPSIS;
}

/**
 * `value` escaped, cut so the escaped text fits `max`: an entity is never
 * split, since the cut happens before escaping.
 */
export function fitEscaped(value: string, max: number, escapeText: (text: string) => string): string {
  let budget = max;
  for (;;) {
    const escaped = escapeText(truncate(value, budget));
    if (escaped.length <= max || budget <= 0) return escaped.length <= max ? escaped : "";
    // Shrink in proportion to the overflow: escaping may expand every character.
    budget = Math.min(budget - 1, Math.floor((budget * max) / escaped.length));
  }
}

/** HTML text and attribute values: `&`, `<`, `>`, `"` and `'` as entities. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
