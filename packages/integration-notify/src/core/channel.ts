import type { BuiltinLocale, CommentAuthorRole, FeedbackStatus, FeedbackType } from "@siteping/core";

/** What a notification is about — the `type` of `@siteping/server`'s `SitepingTeamEvent`. */
export const NOTIFICATION_EVENTS = ["created", "resolved", "reopened", "replied"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Keys of the {@link NotificationField}s the built-in message carries, in this order when present. */
export type NotificationFieldKey =
  | "project"
  | "type"
  | "status"
  | "page"
  | "reporter"
  | "author"
  | "flow"
  | "component";

/** Keys of the {@link NotificationLink}s the built-in message carries, in this order when present. */
export type NotificationLinkKey = "page" | "screenshot" | "recording" | "dashboard";

/** One labelled value, e.g. `Project: acme`. */
export interface NotificationField {
  key: NotificationFieldKey | (string & {});
  /** In the notifier's locale. */
  label: string;
  /** One line, redacted, invisible and bidirectional control characters out — not escaped for any outlet. */
  value: string;
}

/** A link, always an absolute `http(s)` URL. */
export interface NotificationLink {
  key: NotificationLinkKey | (string & {});
  label: string;
  url: string;
}

/**
 * A notification, channel-neutral: every channel renders it its own way
 * (Block Kit, Telegram HTML, a plain WhatsApp text, an email, JSON).
 *
 * Built by `buildNotificationMessage`, every text in it is plain text:
 * redacted, line terminators normalized to `\n`, invisible and
 * bidirectional control characters removed — but **not escaped**, and still
 * visitor-controlled. A channel escapes it for its outlet and truncates it to
 * the outlet's limits; the built-in channels do, and treat a message built by
 * hand (or rewritten by `formatMessage`) the same way.
 */
export interface NotificationMessage {
  event: NotificationEvent;
  feedbackId: string;
  projectName: string;
  feedbackType: FeedbackType;
  /** The feedback's status once the event happened. */
  status: FeedbackStatus;
  /** One line, e.g. `New bug on acme`. */
  title: string;
  /** The feedback's message, or the reply's body for `replied` — may span lines. */
  summary: string;
  fields: NotificationField[];
  links: NotificationLink[];
  /** The reply's author for `replied`. */
  reply?: { authorName: string; authorRole: CommentAuthorRole } | undefined;
  /** When the event happened, ISO 8601. */
  occurredAt: string;
  /** Locale of the labels and the title. */
  locale: BuiltinLocale;
}

/** What a channel gets beside the message. */
export interface NotificationSendContext {
  /**
   * Aborted when the attempt times out (`timeoutMs`): pass it to `fetch`.
   * A channel that ignores it is abandoned all the same — its attempt
   * counts as failed — but keeps running in the background.
   */
  signal: AbortSignal;
  /** 1 for the first attempt, 2 for the first retry… */
  attempt: number;
}

/**
 * An outlet: Slack, Telegram, WhatsApp, email, a webhook — or anything you
 * write. `send` resolves once the outlet accepted the message and throws
 * otherwise; throw a `NotificationDeliveryError` with `retryable: false` for
 * a failure a retry cannot fix (a revoked token, a refused payload). Every
 * other throw is retried.
 *
 * Destinations (URLs, tokens, chat ids, recipients) belong to the channel's
 * own configuration, never to the message: everything in a message may
 * come from a visitor.
 */
export interface NotificationChannel {
  /** Names the channel in logs and results, e.g. `slack` or `slack:#support`. Never put a secret in it. */
  readonly name: string;
  send(message: NotificationMessage, context: NotificationSendContext): Promise<void>;
}
