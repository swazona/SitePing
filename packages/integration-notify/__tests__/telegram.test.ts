import { describe, expect, it } from "vitest";
import { buildTelegramText, createTelegramChannel } from "../src/channels/telegram.js";
import { message, mockFetch, sendContext } from "./fixtures.js";

const TOKEN = "123456789:AAH-secret_token_value_0123456789";

/** What Telegram shows once it parsed the HTML. */
function visible(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("Telegram channel", () => {
  it("calls sendMessage with HTML, previews off", async () => {
    const { fetch, calls } = mockFetch(Response.json({ ok: true, result: {} }));
    const channel = createTelegramChannel({ botToken: TOKEN, chatId: -1001234567890, messageThreadId: 7, fetch });

    await channel.send(message(), sendContext());

    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({
      chat_id: "-1001234567890",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      message_thread_id: 7,
      text:
        "<b>New bug on acme</b>\n\n<blockquote>The checkout button does nothing</blockquote>\n\n" +
        '<b>Project:</b> acme\n<b>Page:</b> /checkout\n\n<a href="https://cdn.acme.com/shots/1.jpg">Screenshot</a>',
    });
  });

  it("escapes every visitor text, so injected tags and attributes stay text", () => {
    const text = buildTelegramText(
      message({
        title: '<a href="tg://evil">x</a>',
        summary: "</blockquote><b>fake</b> & more",
        fields: [{ key: "page", label: "Page", value: '" onmouseover="x' }],
        links: [
          { key: "page", label: "<i>Open</i>", url: 'https://acme.com/?q="><script>' },
          { key: "evil", label: "Evil", url: "tg://resolve?domain=evil" },
        ],
      }),
    );
    const tags = text.match(/<[^>]+>/g) ?? [];
    expect(new Set(tags.map((tag) => tag.replace(/ href="[^"]*"/, "")))).toEqual(
      new Set(["<b>", "</b>", "<blockquote>", "</blockquote>", "<a>", "</a>"]),
    );
    expect(text).toContain("&lt;/blockquote&gt;&lt;b&gt;fake&lt;/b&gt; &amp; more");
    expect(text).toContain('<a href="https://acme.com/?q=&quot;&gt;&lt;script&gt;">&lt;i&gt;Open&lt;/i&gt;</a>');
    expect(text).not.toContain('href="tg:');
  });

  it("keeps the visible text within 4096 characters", () => {
    const text = buildTelegramText(
      message({
        title: "t".repeat(1000),
        summary: "&".repeat(10_000),
        fields: Array.from({ length: 20 }, (_, i) => ({ key: `f${i}`, label: "Label", value: "<".repeat(1000) })),
      }),
    );
    expect(visible(text).length).toBeLessThanOrEqual(4096);
    expect(text).toContain("<blockquote>&amp;");
  });

  it("reads Telegram's description and retry_after on a refusal", async () => {
    const channel = createTelegramChannel({
      botToken: TOKEN,
      chatId: "@acme_team",
      fetch: mockFetch(
        Response.json(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 3",
            parameters: { retry_after: 3 },
          },
          { status: 429 },
        ),
      ).fetch,
    });
    const error = await channel.send(message(), sendContext()).catch((e: unknown) => e);
    expect(error).toMatchObject({
      channel: "telegram",
      status: 429,
      retryable: true,
      retryAfterMs: 3000,
      detail: "Too Many Requests: retry after 3",
    });
    expect(JSON.stringify(error)).not.toContain("secret_token");
    expect((error as Error).message).not.toContain("secret_token");

    const unauthorized = createTelegramChannel({
      botToken: TOKEN,
      chatId: 42,
      fetch: mockFetch(Response.json({ ok: false, description: "Unauthorized" }, { status: 401 })).fetch,
    });
    await expect(unauthorized.send(message(), sendContext())).rejects.toMatchObject({ retryable: false });
  });

  it("refuses a malformed token or chat id, never echoing the token", () => {
    expect(() => createTelegramChannel({ botToken: "123:short", chatId: 1 })).toThrow(/botToken/);
    expect(() => createTelegramChannel({ botToken: `${TOKEN}/../../evil`, chatId: 1 })).toThrow(/^(?!.*secret_token)/s);
    expect(() => createTelegramChannel({ botToken: TOKEN, chatId: "1; drop" })).toThrow(/chatId/);
    expect(() => createTelegramChannel({ botToken: TOKEN, chatId: 1, apiBaseUrl: "http://bot.example" })).toThrow(
      /https/,
    );
    expect(() => createTelegramChannel({ botToken: TOKEN, chatId: 1, messageThreadId: 0 })).toThrow(/messageThreadId/);
  });
});
