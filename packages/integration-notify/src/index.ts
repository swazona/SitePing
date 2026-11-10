/**
 * Team notifications for SitePing: build `notifyTeam` for
 * `@siteping/server` with `createTeamNotifier` and pick channels:
 *
 * - `@siteping/integration-notify/slack` — Slack incoming webhooks (Block Kit)
 * - `@siteping/integration-notify/telegram` — Telegram Bot API (HTML)
 * - `@siteping/integration-notify/whatsapp` — WhatsApp Cloud API (text or template)
 * - `@siteping/integration-notify/email` — email through your own transport
 * - `@siteping/integration-notify/webhook` — a signed JSON webhook (n8n, Discord, Teams…)
 *
 * Or implement `NotificationChannel` for any other outlet.
 */
export {
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationField,
  type NotificationFieldKey,
  type NotificationLink,
  type NotificationLinkKey,
  type NotificationMessage,
  type NotificationSendContext,
} from "./core/channel.js";
export {
  createNotificationDispatcher,
  type NotificationDelivery,
  type NotificationDispatcher,
  type NotificationDispatcherOptions,
  type NotificationLogger,
  type NotificationRoute,
} from "./core/dispatcher.js";
export {
  isNotificationDeliveryError,
  NotificationDeliveryError,
  type NotificationDeliveryErrorOptions,
} from "./core/errors.js";
export { NOTIFICATION_STRINGS, type NotificationStrings } from "./core/i18n.js";
export {
  buildNotificationMessage,
  type NotificationMessageOptions,
  type NotificationRedaction,
  type TeamNotificationComment,
  type TeamNotificationEvent,
} from "./core/message.js";
export { createTeamNotifier, type TeamNotifier, type TeamNotifierOptions } from "./core/notifier.js";
