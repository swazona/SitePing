/**
 * WhatsApp, through Meta's Cloud API (`POST /{phone-number-id}/messages`).
 *
 * **Business-initiated messages.** A free-form `text` message is delivered
 * only inside the 24-hour customer service window: the recipient must have
 * written to your business number within the last 24 hours. Outside it,
 * Meta refuses the message (error 131047) and only an approved *template*
 * message goes through. Since notifications start the conversation, pass
 * `template` with a utility template approved in WhatsApp Manager to reach
 * a recipient at any time; its body variables then carry the notification.
 * Template variables may not contain line breaks or tabs, nor more than
 * four spaces in a row, and are capped at 1024 characters here — the
 * channel flattens and cuts them. Template messages are billed per message.
 *
 * WhatsApp has no escape for its `*bold*`, `_italic_`, `~strike~` and
 * backtick markers: a visitor's text may use them. It cannot mention
 * anyone, and link previews are off.
 */
import type { NotificationChannel, NotificationMessage } from "../core/channel.js";
import { NotificationDeliveryError } from "../core/errors.js";
import { destinationUrl, jsonField, post } from "../core/http.js";
import { oneLine, textBlock, truncate } from "../core/text.js";

/** An approved template, its body variables built from the message. */
export interface WhatsAppTemplate {
  /** The template's name in WhatsApp Manager. */
  name: string;
  /** Its language code, e.g. `en_US` or `fr`. */
  language: string;
  /**
   * The body variables `{{1}}`, `{{2}}`…, in order. Defaults to the title,
   * then the summary — for a template like `{{1}}: {{2}}`.
   */
  parameters?: ((message: NotificationMessage) => readonly string[]) | undefined;
}

export interface WhatsAppChannelOptions {
  /** A system user's access token with `whatsapp_business_messaging` — a secret: read it from the environment. */
  accessToken: string;
  /** The sending number's id (WhatsApp Manager → API setup), digits only. */
  phoneNumberId: string;
  /** The recipient, in international format (`+33612345678` or `33612345678`). One channel per recipient. */
  to: string;
  /** Send this template instead of a text message — see the module notes on the 24-hour window. */
  template?: WhatsAppTemplate | undefined;
  /** Graph API version. Defaults to `v23.0`. */
  apiVersion?: string | undefined;
  /** Defaults to `https://graph.facebook.com`. */
  apiBaseUrl?: string | undefined;
  /** Names the channel in logs and results. Defaults to `whatsapp`. */
  name?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** A text message's body limit. */
const WHATSAPP_TEXT_LIMIT = 4096;
/** Longest template variable sent. */
const TEMPLATE_PARAMETER_MAX = 1024;
const TITLE_MAX = 256;
const FIELD_MAX = 300;

/** A template variable as WhatsApp accepts it: one line, at most four spaces in a row, cut to 1024 characters. */
export function toTemplateParameter(value: string): string {
  const flat = oneLine(value).replace(/ {5,}/g, "    ");
  return truncate(flat, TEMPLATE_PARAMETER_MAX) || "-";
}

/** The text body for `message`, within 4096 characters. */
export function buildWhatsAppText(message: NotificationMessage): string {
  const title = truncate(oneLine(message.title), TITLE_MAX);
  const lines = message.fields.map((field) => `${oneLine(field.label)}: ${truncate(oneLine(field.value), FIELD_MAX)}`);
  const links = message.links
    .filter((link) => /^https?:\/\//i.test(link.url))
    .map((link) => `${oneLine(link.label)}: ${link.url}`);
  const tail = [lines.join("\n"), links.join("\n")].filter(Boolean).join("\n\n");
  const fixed = title.length + tail.length + 8;
  const summary = truncate(textBlock(message.summary), Math.max(0, WHATSAPP_TEXT_LIMIT - fixed));
  return truncate([`*${title}*`, summary, tail].filter(Boolean).join("\n\n"), WHATSAPP_TEXT_LIMIT);
}

/**
 * A channel sending each notification to one WhatsApp number.
 *
 * @throws Error for a malformed `phoneNumberId`, `to` or `apiVersion`, or a
 * missing `accessToken` (none of them echoed).
 */
export function createWhatsAppChannel(options: WhatsAppChannelOptions): NotificationChannel {
  if (typeof options.accessToken !== "string" || !/^[A-Za-z0-9._|-]{16,}$/.test(options.accessToken)) {
    throw new Error("[siteping] createWhatsAppChannel: `accessToken` is missing or malformed");
  }
  if (typeof options.phoneNumberId !== "string" || !/^\d{5,25}$/.test(options.phoneNumberId)) {
    throw new Error("[siteping] createWhatsAppChannel: `phoneNumberId` must be the number's numeric id");
  }
  const to = typeof options.to === "string" ? options.to.replace(/^\+/, "") : "";
  if (!/^\d{7,15}$/.test(to)) {
    throw new Error("[siteping] createWhatsAppChannel: `to` must be a phone number in international format");
  }
  const apiVersion = options.apiVersion ?? "v23.0";
  if (!/^v\d{1,3}\.\d{1,3}$/.test(apiVersion)) {
    throw new Error("[siteping] createWhatsAppChannel: `apiVersion` must look like `v23.0`");
  }
  const { template } = options;
  if (
    template &&
    (!/^[a-z0-9_]{1,512}$/.test(template.name) || !/^[A-Za-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(template.language))
  ) {
    throw new Error("[siteping] createWhatsAppChannel: `template` needs a template name and a language code");
  }
  const base = destinationUrl(
    "createWhatsAppChannel",
    "apiBaseUrl",
    options.apiBaseUrl ?? "https://graph.facebook.com",
  );
  const url = new URL(`${base.href.replace(/\/$/, "")}/${apiVersion}/${options.phoneNumberId}/messages`);
  const name = options.name ?? "whatsapp";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" };

  const payload = (message: NotificationMessage): Record<string, unknown> => {
    if (!template) {
      return { type: "text", text: { body: buildWhatsAppText(message), preview_url: false } };
    }
    const values = template.parameters ? template.parameters(message) : [message.title, message.summary];
    return {
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(values.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: values.map((value) => ({ type: "text", text: toTemplateParameter(value) })),
                },
              ],
            }
          : {}),
      },
    };
  };

  return {
    name,
    async send(message, { signal }) {
      let body: string;
      try {
        body = JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload(message) });
      } catch (error) {
        // A throwing `parameters`: no retry builds it better.
        throw new NotificationDeliveryError(
          name,
          `template parameters failed (${error instanceof Error ? error.name : "Error"})`,
          {
            retryable: false,
          },
        );
      }
      await post({
        channel: name,
        url,
        body,
        headers,
        fetch: fetchImplementation,
        signal,
        describe: (text) => {
          const error = jsonField(text, "error") as { message?: unknown; code?: unknown } | undefined;
          const detail =
            typeof error?.message === "string"
              ? `${typeof error.code === "number" ? `${error.code}: ` : ""}${error.message}`
              : undefined;
          return detail === undefined ? {} : { detail };
        },
      });
    },
  };
}
