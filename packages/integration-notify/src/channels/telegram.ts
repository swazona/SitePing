/**
 * Telegram, through the Bot API's `sendMessage` with the HTML parse mode.
 *
 * Every text is escaped for Telegram's HTML (`&`, `<`, `>`, `"`), so a
 * visitor's `<a href>` or `<b>` stays text; the only tags are the
 * channel's own. Link previews are off: Telegram would otherwise fetch the
 * first URL, a visitor-named page included.
 */
import type { NotificationChannel, NotificationMessage } from "../core/channel.js";
import { destinationUrl, jsonField, post } from "../core/http.js";
import { escapeHtml, oneLine, textBlock, truncate } from "../core/text.js";

export interface TelegramChannelOptions {
  /** The bot's token from @BotFather (`123456:ABC…`) — a secret: read it from the environment. */
  botToken: string;
  /** The chat to post to: a numeric id (groups are negative), or `@channelusername`. */
  chatId: string | number;
  /** The topic of a forum supergroup to post in. */
  messageThreadId?: number | undefined;
  /** Send silently: members get no sound. Defaults to `false`. */
  disableNotification?: boolean | undefined;
  /** A self-hosted Bot API server. Defaults to `https://api.telegram.org`. */
  apiBaseUrl?: string | undefined;
  /** Names the channel in logs and results. Defaults to `telegram`. */
  name?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** `sendMessage`'s text limit, counted after entities parsing: the visible characters. */
const TELEGRAM_TEXT_LIMIT = 4096;
const TITLE_MAX = 256;
const FIELD_MAX = 300;
const FIELDS_SHOWN = 10;
const LINKS_SHOWN = 5;

const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,})$/;

/** The `text` for `message`, in Telegram HTML, its visible length within 4096 characters. */
export function buildTelegramText(message: NotificationMessage): string {
  const title = truncate(oneLine(message.title), TITLE_MAX);
  const fields = message.fields.slice(0, FIELDS_SHOWN).map((field) => ({
    label: oneLine(field.label),
    value: truncate(oneLine(field.value), FIELD_MAX),
  }));
  const links = message.links
    .filter((link) => /^https?:\/\//i.test(link.url))
    .slice(0, LINKS_SHOWN)
    .map((link) => ({ label: oneLine(link.label) || link.key, url: link.url }));

  // Visible characters besides the summary: what the HTML shows once parsed.
  const fixed =
    title.length +
    fields.reduce((sum, field) => sum + field.label.length + field.value.length + 3, 0) +
    links.reduce((sum, link) => sum + link.label.length + 3, 0) +
    8;
  const summary = truncate(textBlock(message.summary), Math.max(0, TELEGRAM_TEXT_LIMIT - fixed));

  const parts = [`<b>${escapeHtml(title)}</b>`];
  if (summary) parts.push(`<blockquote>${escapeHtml(summary)}</blockquote>`);
  if (fields.length > 0) {
    parts.push(fields.map((field) => `<b>${escapeHtml(field.label)}:</b> ${escapeHtml(field.value)}`).join("\n"));
  }
  if (links.length > 0) {
    parts.push(links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join(" · "));
  }
  return parts.join("\n\n");
}

/**
 * A channel posting to a Telegram chat as a bot. Add the bot to the group
 * (or as an admin of the channel) first.
 *
 * @throws Error for a malformed `botToken` or `chatId` (never echoed), or an
 * `apiBaseUrl` that is not https.
 */
export function createTelegramChannel(options: TelegramChannelOptions): NotificationChannel {
  // The token goes into the URL path: its shape is checked so it can only ever be one segment.
  if (typeof options.botToken !== "string" || !BOT_TOKEN.test(options.botToken)) {
    throw new Error("[siteping] createTelegramChannel: `botToken` is not a Bot API token (`<digits>:<secret>`)");
  }
  const chatId = String(options.chatId);
  if (!CHAT_ID.test(chatId)) {
    throw new Error("[siteping] createTelegramChannel: `chatId` must be a numeric chat id or an @username");
  }
  const { messageThreadId } = options;
  if (messageThreadId !== undefined && (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0)) {
    throw new Error("[siteping] createTelegramChannel: `messageThreadId` must be a positive integer");
  }
  const base = destinationUrl("createTelegramChannel", "apiBaseUrl", options.apiBaseUrl ?? "https://api.telegram.org");
  const url = new URL(`${base.href.replace(/\/$/, "")}/bot${options.botToken}/sendMessage`);
  const name = options.name ?? "telegram";
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    name,
    async send(message, { signal }) {
      const body = {
        chat_id: chatId,
        text: buildTelegramText(message),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(options.disableNotification ? { disable_notification: true } : {}),
        ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      };
      await post({
        channel: name,
        url,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        fetch: fetchImplementation,
        signal,
        describe: (text) => {
          const description = jsonField(text, "description");
          const parameters = jsonField(text, "parameters") as { retry_after?: unknown } | undefined;
          const retryAfter = typeof parameters?.retry_after === "number" ? parameters.retry_after * 1000 : undefined;
          return {
            ...(typeof description === "string" ? { detail: description } : {}),
            ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
          };
        },
      });
    },
  };
}
