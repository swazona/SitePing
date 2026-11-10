/**
 * Email, through a transport you inject — nodemailer, Resend, SES, Postmark:
 * the package depends on no mail library and speaks no SMTP.
 *
 * Recipients and sender come from the channel's options only. The subject
 * is one line (no header injection through a line break), and the HTML
 * body escapes every value; links are http(s) only.
 */
import { isValidEmail } from "@siteping/core";
import type { NotificationChannel, NotificationMessage } from "../core/channel.js";
import { escapeHtml, oneLine, textBlock, truncate } from "../core/text.js";

/** The email the channel hands to `send`. */
export interface NotificationEmail {
  to: string[];
  /** The `from` option, when set; else your transport's default sender. */
  from?: string | undefined;
  subject: string;
  text: string;
  html: string;
  /** `X-Siteping-Event` and `X-Siteping-Feedback`, for filters and threading. */
  headers: Record<string, string>;
}

export interface EmailChannelOptions {
  /**
   * Deliver one email; resolve once the transport accepted it, throw
   * otherwise (a throw is retried — a transport that may have sent before
   * failing can send twice).
   */
  send: (mail: NotificationEmail) => Promise<unknown> | unknown;
  /** Recipients: the team's addresses. */
  to: string | readonly string[];
  /** Sender, e.g. `SitePing <feedback@acme.com>`. */
  from?: string | undefined;
  /** Put before every subject, e.g. `[acme]`. */
  subjectPrefix?: string | undefined;
  /** Names the channel in logs and results. Defaults to `email`. */
  name?: string | undefined;
}

const SUBJECT_MAX = 200;
const FIELD_MAX = 500;
const SUMMARY_MAX = 10_000;

/** Subject, text and HTML bodies for `message`. */
export function buildEmailContent(
  message: NotificationMessage,
  subjectPrefix = "",
): Pick<NotificationEmail, "subject" | "text" | "html"> {
  const title = oneLine(message.title);
  const prefix = oneLine(subjectPrefix);
  const subject = truncate(prefix ? `${prefix} ${title}` : title, SUBJECT_MAX);
  const summary = truncate(textBlock(message.summary), SUMMARY_MAX);
  const fields = message.fields.map((field) => ({
    label: oneLine(field.label),
    value: truncate(oneLine(field.value), FIELD_MAX),
  }));
  const links = message.links
    .filter((link) => /^https?:\/\//i.test(link.url))
    .map((link) => ({ label: oneLine(link.label) || link.key, url: link.url }));

  const text = [
    title,
    summary,
    fields.map((field) => `${field.label}: ${field.value}`).join("\n"),
    links.map((link) => `${link.label}: ${link.url}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const rows = fields
    .map(
      (field) =>
        `<tr><th align="left" style="padding:2px 12px 2px 0;color:#555;font-weight:600">${escapeHtml(field.label)}</th>` +
        `<td style="padding:2px 0">${escapeHtml(field.value)}</td></tr>`,
    )
    .join("");
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;color:#111">',
    `<h2 style="font-size:16px;margin:0 0 12px">${escapeHtml(title)}</h2>`,
    summary
      ? `<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(summary)}</blockquote>`
      : "",
    rows ? `<table style="border-collapse:collapse;margin:0 0 12px">${rows}</table>` : "",
    links.length > 0
      ? `<p>${links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join(" · ")}</p>`
      : "",
    "</body></html>",
  ].join("");
  return { subject, text, html };
}

/** An address list without a line break or a comma that could add a recipient. */
function checkAddress(option: string, address: unknown, bare: boolean): string {
  const valid =
    typeof address === "string" &&
    !/[\r\n,;]/.test(address) &&
    (bare ? isValidEmail(address) : /<[^<>\s]+@[^<>\s]+>$|^[^<>\s]+@[^<>\s]+$/.test(address.trim()));
  if (!valid) throw new Error(`[siteping] createEmailChannel: \`${option}\` must be an email address`);
  return address.trim();
}

/**
 * A channel emailing the team through `send`.
 *
 * @example nodemailer
 * ```ts
 * const transport = nodemailer.createTransport(process.env.SMTP_URL);
 * createEmailChannel({
 *   to: ["team@acme.com"],
 *   from: "SitePing <feedback@acme.com>",
 *   send: (mail) => transport.sendMail(mail),
 * });
 * ```
 *
 * @throws Error without `send`, or with a recipient or a sender that is not one address.
 */
export function createEmailChannel(options: EmailChannelOptions): NotificationChannel {
  if (typeof options.send !== "function") throw new Error("[siteping] createEmailChannel: `send` must be a function");
  const list = typeof options.to === "string" ? [options.to] : [...(options.to ?? [])];
  if (list.length === 0) throw new Error("[siteping] createEmailChannel: `to` needs at least one address");
  const to = list.map((address) => checkAddress("to", address, true));
  const from = options.from === undefined ? undefined : checkAddress("from", options.from, false);
  const name = options.name ?? "email";
  const { send, subjectPrefix } = options;
  return {
    name,
    async send(message) {
      const content = buildEmailContent(message, subjectPrefix);
      await send({
        to: [...to],
        ...(from === undefined ? {} : { from }),
        ...content,
        headers: {
          "X-Siteping-Event": message.event,
          "X-Siteping-Feedback": oneLine(message.feedbackId).replace(/[^\w.-]/g, ""),
        },
      });
    },
  };
}
