import { BUILTIN_LOCALES, type FeedbackRecord, parseHttpUrl } from "@siteping/core";
import type { NotificationMessage } from "./channel.js";
import { createNotificationDispatcher, type NotificationDispatcherOptions, safeLog } from "./dispatcher.js";
import { buildNotificationMessage, type NotificationMessageOptions, type TeamNotificationEvent } from "./message.js";

export interface TeamNotifierOptions extends NotificationMessageOptions, NotificationDispatcherOptions {
  /**
   * Notify replies the team posts too, not only the reporters'. Defaults
   * to `false`: whoever answered from the dashboard needs no ping about it.
   */
  teamReplies?: boolean | undefined;
  /**
   * Rewrite the built-in message, e.g. to add a field or drop a link.
   * Whatever it returns still goes through each channel's escaping and
   * limits, but no longer through the redaction: redact what you add.
   */
  formatMessage?:
    | ((message: NotificationMessage, feedback: FeedbackRecord, event: TeamNotificationEvent) => NotificationMessage)
    | undefined;
}

/**
 * `@siteping/server`'s `notifyTeam`, typed structurally so the package
 * depends on no server version. Resolves once every channel is done (sent,
 * skipped or given up on) and never rejects: failures are logged.
 */
export type TeamNotifier = (feedback: FeedbackRecord, event: TeamNotificationEvent) => Promise<void>;

/**
 * Build `notifyTeam` for `createSitepingHandler`: each event becomes one
 * channel-neutral message (redacted, see `buildNotificationMessage`), sent
 * to every channel that takes it.
 *
 * @example
 * ```ts
 * import { createTeamNotifier } from "@siteping/integration-notify";
 * import { createSlackChannel } from "@siteping/integration-notify/slack";
 *
 * createSitepingHandler({
 *   store,
 *   apiKey: process.env.SITEPING_API_KEY,
 *   waitUntil: after,
 *   notifyTeam: createTeamNotifier({
 *     siteUrl: "https://acme.com",
 *     channels: [createSlackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })],
 *   }),
 * });
 * ```
 *
 * @throws Error at creation — see `createNotificationDispatcher`.
 */
export function createTeamNotifier(options: TeamNotifierOptions): TeamNotifier {
  const { teamReplies = false, formatMessage, siteUrl, locale } = options;
  if (siteUrl !== undefined && !parseHttpUrl(siteUrl)) {
    // Not echoed: a staging URL may carry credentials, and this error is logged.
    throw new Error("[siteping] createTeamNotifier: `siteUrl` must be an absolute http(s) URL");
  }
  if (locale !== undefined && !(BUILTIN_LOCALES as readonly string[]).includes(locale)) {
    throw new Error(`[siteping] createTeamNotifier: unknown locale "${String(locale)}"`);
  }
  const dispatcher = createNotificationDispatcher(options);
  const logger = options.logger ?? console;
  return async (feedback, event) => {
    if (event.type === "replied" && event.comment.authorRole === "team" && !teamReplies) return;
    let message: NotificationMessage;
    try {
      const built = buildNotificationMessage(feedback, event, options);
      message = formatMessage ? formatMessage(built, feedback, event) : built;
    } catch (error) {
      safeLog(logger, "[siteping] Notification message could not be built", {
        event: event.type,
        feedbackId: feedback.id,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return;
    }
    await dispatcher.dispatch(message);
  };
}
