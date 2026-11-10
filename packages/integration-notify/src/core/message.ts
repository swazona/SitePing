import {
  type BuiltinLocale,
  type ClosedFeedbackStatus,
  type CommentRecord,
  type FeedbackRecord,
  interpolate,
  type OpenFeedbackStatus,
  parseHttpUrl,
} from "@siteping/core";
import { createReportRedactor } from "@siteping/core/report";
import type { NotificationField, NotificationLink, NotificationMessage } from "./channel.js";
import { NOTIFICATION_STRINGS, type NotificationStrings } from "./i18n.js";
import { oneLine, textBlock, truncate } from "./text.js";

/** A stored reply and its feedback's project — `@siteping/server`'s `SitepingCreatedComment`, restated. */
export interface TeamNotificationComment extends CommentRecord {
  projectName: string;
}

/**
 * What happened to a feedback — `@siteping/server`'s `SitepingTeamEvent`,
 * restated so this package depends on no server version: one 0.x release
 * installs next to any server. A type test keeps the two identical.
 */
export type TeamNotificationEvent =
  | { type: "created" }
  | { type: "resolved"; status: ClosedFeedbackStatus }
  | { type: "reopened"; status: OpenFeedbackStatus }
  | { type: "replied"; comment: TeamNotificationComment };

/** What the built-in redaction removes from every text and URL — the dashboard export's and the MCP server's patterns. */
export interface NotificationRedaction {
  /** Bearer tokens, JWTs, well-known API keys, `token=`-like values → `[secret]`. Default `true`. */
  secrets?: boolean | undefined;
  /** Email addresses → `[email]`. Default `false`. */
  emails?: boolean | undefined;
  /** URL query strings → `?[redacted]`. Default `false`. */
  queryStrings?: boolean | undefined;
}

export interface NotificationMessageOptions {
  /** Locale of the labels and titles, one of the built-in ones. Defaults to `en`. */
  locale?: BuiltinLocale | undefined;
  /** Override some of the locale's strings. */
  strings?: Partial<NotificationStrings> | undefined;
  /**
   * Redaction of every text and URL the message quotes, or `false` for none
   * (invisible and bidirectional control characters are removed all the
   * same). Defaults to secrets on, emails and query strings off.
   */
  redact?: NotificationRedaction | false | undefined;
  /**
   * Origin of the site the widget runs on, e.g. `https://acme.com`. Page
   * URLs resolve against it (the widget records `location.pathname` by
   * default), and the page link only ever points to it: without it, the
   * page is shown as text, never as a link, since a visitor names it.
   */
  siteUrl?: string | undefined;
  /** Query parameter of the widget's deep link (`SitepingConfig.deepLink`) on the page link, or `false` for none. Default `siteping`. */
  deepLinkParam?: string | false | undefined;
  /** The feedback's address in your dashboard, for an "Open in the dashboard" link. Must return an absolute http(s) URL. */
  dashboardUrl?: ((feedback: FeedbackRecord) => string | null | undefined) | undefined;
  /** Show the reporter's email beside their name. Defaults to `false` — chat channels are often wide. */
  includeAuthorEmail?: boolean | undefined;
}

/** Longest summary a message keeps, in UTF-16 code units — every built-in channel cuts it further to its own limit. */
const SUMMARY_MAX_LENGTH = 3000;
/** Longest field value a message keeps. */
const FIELD_MAX_LENGTH = 500;
/** Component names shown, the nearest to the element kept. */
const COMPONENTS_SHOWN = 6;
const DEFAULT_DEEP_LINK_PARAM = "siteping";

function iso(value: Date | string): string {
  if (typeof value === "string") return value;
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

/** `url` when it is an absolute http(s) URL, as the URL parser serializes it. */
function httpLink(url: string | null | undefined): string | null {
  if (!url) return null;
  return parseHttpUrl(url)?.href ?? null;
}

/**
 * The channel-neutral message for `event` on `feedback`. Every text is
 * redacted, cleaned of invisible and bidirectional control characters and
 * bounded, but left unescaped: each channel escapes for its outlet. Links
 * are absolute http(s) URLs only: the page link points to `siteUrl` alone,
 * a `data:` screenshot (no `ScreenshotStorage`) gets none.
 */
export function buildNotificationMessage(
  feedback: FeedbackRecord,
  event: TeamNotificationEvent,
  options: NotificationMessageOptions = {},
): NotificationMessage {
  const locale = options.locale ?? "en";
  const strings: NotificationStrings = { ...NOTIFICATION_STRINGS[locale], ...options.strings };
  const redactor = createReportRedactor(options.redact === false ? { secrets: false } : (options.redact ?? {}));
  const line = (value: string, max = FIELD_MAX_LENGTH) => truncate(oneLine(redactor.text(value)), max);

  const project = line(feedback.projectName);
  const type = strings.types[feedback.type] ?? feedback.type;
  const reply = event.type === "replied" ? event.comment : null;
  const replyAuthor = reply ? line(reply.authorName) || strings.anonymous : "";
  const titles = {
    created: strings.titleCreated,
    resolved: event.type === "resolved" && event.status === "wont_fix" ? strings.titleWontFix : strings.titleResolved,
    reopened: strings.titleReopened,
    replied: strings.titleReplied,
  } as const;
  const title = line(interpolate(titles[event.type], { type, project, author: replyAuthor }));
  const summary = truncate(textBlock(redactor.text(reply ? reply.body : feedback.message)), SUMMARY_MAX_LENGTH);

  const fields: NotificationField[] = [];
  const field = (key: NotificationField["key"], label: string, value: string) => {
    if (value) fields.push({ key, label, value });
  };
  field("project", strings.fieldProject, project);
  field("type", strings.fieldType, type);
  if (event.type !== "created") field("status", strings.fieldStatus, strings.statuses[feedback.status]);
  field("page", strings.fieldPage, line(redactor.url(feedback.url)));
  const reporterName = line(feedback.authorName) || strings.anonymous;
  const reporterEmail = options.includeAuthorEmail ? line(feedback.authorEmail) : "";
  field("reporter", strings.fieldReporter, reporterEmail ? `${reporterName} <${reporterEmail}>` : reporterName);
  if (reply) field("author", strings.fieldAuthor, `${replyAuthor} (${strings.roles[reply.authorRole]})`);
  if (typeof feedback.flowStep === "number") {
    const flowTitle = feedback.flowTitle ? line(feedback.flowTitle, 200) : "";
    const template = flowTitle ? strings.flowStepTitled : strings.flowStep;
    field("flow", strings.fieldFlow, line(interpolate(template, { step: feedback.flowStep, title: flowTitle })));
  }
  const components = feedback.diagnostics?.components ?? [];
  if (components.length > 0) {
    field("component", strings.fieldComponent, line(components.slice(-COMPONENTS_SHOWN).join(" › ")));
  }

  const links: NotificationLink[] = [];
  const link = (key: NotificationLink["key"], label: string, url: string | null) => {
    if (url) links.push({ key, label, url });
  };
  const site = options.siteUrl === undefined ? null : parseHttpUrl(options.siteUrl);
  if (site) {
    // Resolved against the site, then kept only on it: a visitor names the URL.
    const page = parseHttpUrl(redactor.url(feedback.url), site.href);
    if (page && page.origin === site.origin) {
      page.username = "";
      page.password = "";
      const param = options.deepLinkParam ?? DEFAULT_DEEP_LINK_PARAM;
      if (param !== false) page.searchParams.set(param, feedback.id);
      link("page", strings.linkPage, page.href);
    }
  }
  link("screenshot", strings.linkScreenshot, httpLink(feedback.screenshotUrl));
  link("recording", strings.linkRecording, httpLink(feedback.diagnostics?.recording?.url));
  link("dashboard", strings.linkDashboard, httpLink(options.dashboardUrl?.(feedback)));

  const occurredAt = reply ? reply.createdAt : event.type === "created" ? feedback.createdAt : feedback.updatedAt;
  return {
    event: event.type,
    feedbackId: feedback.id,
    projectName: project,
    feedbackType: feedback.type,
    status: feedback.status,
    title,
    summary,
    fields,
    links,
    ...(reply ? { reply: { authorName: replyAuthor, authorRole: reply.authorRole } } : {}),
    occurredAt: iso(occurredAt),
    locale,
  };
}
