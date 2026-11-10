import { describe, expect, it } from "vitest";
import { buildSlackPayload, createSlackChannel, escapeSlackText } from "../src/channels/slack.js";
import { isNotificationDeliveryError } from "../src/index.js";
import { message, mockFetch, sendContext } from "./fixtures.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX";

interface Block {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

const blocks = (payload: Record<string, unknown>) => payload.blocks as Block[];

describe("Slack channel", () => {
  it("posts Block Kit to the webhook, previews off", async () => {
    const { fetch, calls } = mockFetch(new Response("ok"));
    const channel = createSlackChannel({ webhookUrl: WEBHOOK, fetch });

    await channel.send(message(), sendContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    const payload = JSON.parse(calls[0]?.body ?? "{}");
    expect(payload).toMatchObject({ unfurl_links: false, unfurl_media: false });
    expect(blocks(payload).map((block) => block.type)).toEqual(["header", "section", "section", "context"]);
    expect(blocks(payload)[0]?.text).toEqual({ type: "plain_text", text: "New bug on acme", emoji: false });
    expect(blocks(payload)[2]?.fields?.map((field) => field.text)).toEqual(["Project: acme", "Page: /checkout"]);
    expect(blocks(payload)[3]?.elements?.[0]).toEqual({
      type: "mrkdwn",
      text: "<https://cdn.acme.com/shots/1.jpg|Screenshot>",
    });
  });

  it("keeps visitor text out of mrkdwn and defuses mentions and control sequences", () => {
    const hostile = "<!channel> <@U123> <https://evil.example|click> @here & *bold* `code`";
    const payload = buildSlackPayload(
      message({
        title: hostile,
        summary: hostile,
        fields: [{ key: "reporter", label: "Reporter", value: "<!everyone>" }],
        links: [
          { key: "page", label: "Page|<x>", url: "https://acme.com/a|b?q=<x>" },
          { key: "evil", label: "Evil", url: "javascript:alert(1)" },
        ],
      }),
    );
    const visitorTexts = [
      payload.text as string,
      blocks(payload)[0]?.text?.text,
      blocks(payload)[1]?.text?.text,
      ...(blocks(payload)[2]?.fields ?? []).map((field) => field.text),
    ].join("\n");
    expect(visitorTexts).not.toMatch(/[<>]/);
    expect(visitorTexts).toContain("&lt;!channel&gt;");
    expect(visitorTexts).not.toMatch(/@here/);
    expect(visitorTexts).toContain("&amp;");
    for (const block of blocks(payload).slice(0, 3)) {
      for (const object of [block.text, ...(block.fields ?? [])].filter(Boolean)) {
        expect(object?.type).toBe("plain_text");
      }
    }
    const links = blocks(payload)[3]?.elements?.[0]?.text ?? "";
    expect(links).toBe("<https://acme.com/a%7Cb?q=&lt;x&gt;|Page¦&lt;x&gt;>");
  });

  it("escapes &, < and >, and breaks broadcast mentions", () => {
    expect(escapeSlackText("a & <b> @channel @Here @everyone")).toBe(
      "a &amp; &lt;b&gt; @\u200Bchannel @\u200BHere @\u200Beveryone",
    );
  });

  it("cuts every text to Slack's limits, after escaping", () => {
    const payload = buildSlackPayload(
      message({
        title: "<".repeat(500),
        summary: "&".repeat(5000),
        fields: Array.from({ length: 15 }, (_, i) => ({ key: `f${i}`, label: "L", value: ">".repeat(3000) })),
      }),
    );
    expect(blocks(payload)[0]?.text?.text.length).toBeLessThanOrEqual(150);
    expect(blocks(payload)[1]?.text?.text.length).toBeLessThanOrEqual(3000);
    expect(blocks(payload)[2]?.fields).toHaveLength(10);
    for (const field of blocks(payload)[2]?.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(2000);
    expect((payload.text as string).length).toBeLessThanOrEqual(3000);
    expect(blocks(payload)[0]?.text?.text).toMatch(/^(&lt;)+…$/);
  });

  it("reports a refusal with Slack's reason, retryable or not, never the URL", async () => {
    const refused = createSlackChannel({
      webhookUrl: WEBHOOK,
      fetch: mockFetch(new Response("channel_is_archived", { status: 410 })).fetch,
    });
    const error = await refused.send(message(), sendContext()).catch((e: unknown) => e);
    expect(isNotificationDeliveryError(error) && error).toMatchObject({
      channel: "slack",
      status: 410,
      retryable: false,
      detail: "channel_is_archived",
    });
    expect(String((error as Error).message)).not.toContain("SECRET");

    const limited = createSlackChannel({
      webhookUrl: WEBHOOK,
      fetch: mockFetch(new Response("rate_limited", { status: 429, headers: { "Retry-After": "7" } })).fetch,
    });
    const limitedError = await limited.send(message(), sendContext()).catch((e: unknown) => e);
    expect(limitedError).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });

    const down = createSlackChannel({
      webhookUrl: WEBHOOK,
      fetch: (async () => {
        throw new TypeError(`fetch failed: ${WEBHOOK}`);
      }) as typeof fetch,
    });
    const downError = await down.send(message(), sendContext()).catch((e: unknown) => e);
    expect(downError).toMatchObject({ status: null, retryable: true });
    expect(JSON.stringify(downError)).not.toContain("SECRET");
    expect(String((downError as Error).message)).toBe("[siteping] slack: request failed (TypeError)");
    expect((downError as Error).cause).toBeUndefined();

    const redirected = createSlackChannel({
      webhookUrl: WEBHOOK,
      fetch: mockFetch(new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } })).fetch,
    });
    await expect(redirected.send(message(), sendContext())).rejects.toMatchObject({ status: 302, retryable: false });
  });

  it("refuses a webhook URL that is not https, without echoing it", () => {
    expect(() => createSlackChannel({ webhookUrl: "http://hooks.slack.com/services/SECRET" })).toThrow(/https/);
    expect(() => createSlackChannel({ webhookUrl: "not a url SECRET" })).toThrow(/^(?!.*SECRET)/s);
    expect(() => createSlackChannel({ webhookUrl: "http://localhost:3000/hook" })).not.toThrow();
  });
});
