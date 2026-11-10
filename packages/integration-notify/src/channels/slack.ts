/**
 * Slack, through an incoming webhook, as Block Kit.
 *
 * Every visitor-controlled text sits in a `plain_text` object, which Slack
 * never parses for mentions, links or formatting, and is escaped all the
 * same (`&`, `<`, `>`), with `@channel`, `@here` and `@everyone` broken by a
 * zero-width space. The only `mrkdwn` text is the links line: labels from
 * the notifier's strings, URLs the URL parser serialized and escaped.
 */
import type { NotificationChannel, NotificationMessage } from "../core/channel.js";
import { destinationUrl, post } from "../core/http.js";
import { fitEscaped, oneLine, textBlock } from "../core/text.js";

export interface SlackChannelOptions {
  /** The incoming webhook's URL (`https://hooks.slack.com/services/…`) — a secret: read it from the environment. */
  webhookUrl: string;
  /** Names the channel in logs and results. Defaults to `slack`. */
  name?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** Slack's limits, in characters: header text, section text, one field, fields per section, the fallback text. */
const SLACK_LIMITS = {
  header: 150,
  section: 3000,
  field: 2000,
  fields: 10,
  fallback: 3000,
  context: 3000,
  links: 5,
} as const;
const LINK_SEPARATOR = "  ·  ";

/** Slack's control characters as entities, and broadcast mentions defused. */
export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(channel|here|everyone)\b/gi, "@\u200B$1");
}

/** A URL inside `<url|label>`: escaped, and the `|` that would end it encoded. */
function slackUrl(url: string): string {
  return escapeSlackText(url).replace(/\|/g, "%7C");
}

const plain = (value: string, max: number) => ({
  type: "plain_text" as const,
  text: fitEscaped(value, max, escapeSlackText),
  emoji: false,
});

/** The webhook payload for `message`: header, summary, fields, links; a fallback `text` for notifications. */
export function buildSlackPayload(message: NotificationMessage): Record<string, unknown> {
  const title = oneLine(message.title) || message.event;
  const summary = textBlock(message.summary);
  const blocks: unknown[] = [{ type: "header", text: plain(title, SLACK_LIMITS.header) }];
  if (summary) blocks.push({ type: "section", text: plain(summary, SLACK_LIMITS.section) });
  const fields = message.fields
    .map((field) => `${oneLine(field.label)}: ${oneLine(field.value)}`)
    .filter((text) => text.length > 2)
    .slice(0, SLACK_LIMITS.fields)
    .map((text) => plain(text, SLACK_LIMITS.field));
  if (fields.length > 0) blocks.push({ type: "section", fields });
  // Whole links only, as many as fit the element: a cut one would be a broken `<url|label>`.
  const links: string[] = [];
  let length = 0;
  for (const link of message.links.slice(0, SLACK_LIMITS.links)) {
    if (!/^https?:\/\//i.test(link.url)) continue;
    const text = `<${slackUrl(link.url)}|${escapeSlackText(oneLine(link.label)).replace(/\|/g, "¦")}>`;
    if (length + text.length + LINK_SEPARATOR.length > SLACK_LIMITS.context) continue;
    links.push(text);
    length += text.length + LINK_SEPARATOR.length;
  }
  if (links.length > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: links.join(LINK_SEPARATOR) }] });
  }
  const fallback = summary ? `${title}\n${summary}` : title;
  return {
    text: fitEscaped(fallback, SLACK_LIMITS.fallback, escapeSlackText),
    blocks,
    // A visitor names the page URL: Slack must not fetch it to preview it.
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * A channel posting to a Slack incoming webhook. The webhook decides the
 * Slack channel; one webhook per Slack channel.
 *
 * @throws Error when `webhookUrl` is not an https URL.
 */
export function createSlackChannel(options: SlackChannelOptions): NotificationChannel {
  const url = destinationUrl("createSlackChannel", "webhookUrl", options.webhookUrl);
  const name = options.name ?? "slack";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    name,
    async send(message, { signal }) {
      await post({
        channel: name,
        url,
        body: JSON.stringify(buildSlackPayload(message)),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        fetch: fetchImplementation,
        signal,
        // Slack answers a refusal in plain text: `invalid_payload`, `no_service`, `channel_is_archived`.
        describe: (text) => ({ detail: text }),
      });
    },
  };
}
