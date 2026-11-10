import { MemoryStore } from "@siteping/adapter-memory";
import type { FeedbackResponse } from "@siteping/core";
import { createSitepingHandler } from "@siteping/server";
import { describe, expect, it, vi } from "vitest";
import { createSlackChannel } from "../src/channels/slack.js";
import { createTelegramChannel } from "../src/channels/telegram.js";
import { createTeamNotifier, type NotificationChannel, type NotificationMessage } from "../src/index.js";
import { feedbackRecord, mockFetch, reply } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "a-secret-key";
const TELEGRAM_TOKEN = "123456789:AAH-secret_token_value_0123456789";

function recorder(name = "recorder") {
  const messages: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    name,
    async send(message) {
      messages.push(message);
    },
  };
  return { channel, messages };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const feedbackPayload = {
  projectName: "acme",
  type: "bug",
  message: "<!channel> pay with sk_live_abcdefghijklmnop \u202Eevil",
  url: "/checkout",
  viewport: "1440x900",
  userAgent: "Mozilla/5.0",
  authorName: "Alice",
  authorEmail: "alice@example.com",
  annotations: [],
};

describe("createTeamNotifier", () => {
  it("skips the team's own replies unless asked", async () => {
    const quiet = recorder();
    const all = recorder();
    const team = { type: "replied" as const, comment: reply({ authorRole: "team" }) };
    await createTeamNotifier({ channels: [quiet.channel] })(feedbackRecord(), team);
    await createTeamNotifier({ channels: [all.channel], teamReplies: true })(feedbackRecord(), team);
    await createTeamNotifier({ channels: [quiet.channel] })(feedbackRecord(), { type: "replied", comment: reply() });
    expect(quiet.messages.map((m) => m.reply?.authorRole)).toEqual(["client"]);
    expect(all.messages).toHaveLength(1);
  });

  it("lets formatMessage rewrite the message, and logs a throw without sending", async () => {
    const { channel, messages } = recorder();
    const logger = { error: vi.fn() };
    await createTeamNotifier({
      channels: [channel],
      logger,
      formatMessage: (m, feedback) => ({ ...m, title: `[${feedback.type}] ${m.title}` }),
    })(feedbackRecord(), { type: "created" });
    expect(messages[0]?.title).toBe("[bug] New bug on acme");

    await createTeamNotifier({
      channels: [channel],
      logger,
      formatMessage: () => {
        throw new Error("bad format");
      },
    })(feedbackRecord(), { type: "created" });
    expect(messages).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Notification message could not be built",
      expect.objectContaining({ event: "created", error: "Error: bad format" }),
    );
  });

  it("refuses a siteUrl that is not http(s) and an unknown locale", () => {
    expect(() => createTeamNotifier({ channels: [], siteUrl: "acme.com" })).toThrow(/siteUrl/);
    expect(() => createTeamNotifier({ channels: [], locale: "xx" as "en" })).toThrow(/locale/);
  });
});

describe("notifyTeam on @siteping/server", () => {
  function setup() {
    const slack = mockFetch(new Response("ok"));
    const telegram = mockFetch(Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 }));
    const logger = { error: vi.fn() };
    const pending: Promise<unknown>[] = [];
    const handler = createSitepingHandler({
      store: new MemoryStore(),
      apiKey: API_KEY,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      notifyTeam: createTeamNotifier({
        siteUrl: "https://acme.com",
        retries: 1,
        retryDelayMs: 0,
        logger,
        channels: [
          createSlackChannel({ webhookUrl: "https://hooks.slack.com/services/T/B/SLACKSECRET", fetch: slack.fetch }),
          {
            channel: createTelegramChannel({ botToken: TELEGRAM_TOKEN, chatId: -100, fetch: telegram.fetch }),
            events: ["created"],
          },
        ],
      }),
    });
    return { handler, slack, telegram, logger, settle: () => Promise.all(pending) };
  }

  it("notifies a new feedback, redacted and escaped, and isolates a failing channel from the request", async () => {
    const { handler, slack, telegram, logger, settle } = setup();

    const response = await handler.POST(post({ ...feedbackPayload, clientId: "n-1" }));
    expect(response.status).toBe(201);
    await settle();

    expect(slack.calls).toHaveLength(1);
    const body = slack.calls[0]?.body ?? "";
    expect(body).toContain("&lt;!channel&gt; pay with [secret] evil");
    expect(body).not.toContain("sk_live");
    expect(body).not.toContain("<!channel>");
    expect(body).not.toMatch(/\u202E/);
    expect(body).toContain("https://acme.com/checkout?siteping=");

    expect(telegram.calls).toHaveLength(2); // one retry, then given up
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Notification to telegram failed",
      expect.objectContaining({ status: 502, attempts: 2, detail: "Bad Gateway", projectName: "acme" }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/secret_token|SLACKSECRET/);
  });

  it("notifies status changes and reporter replies through the routes that take them", async () => {
    const { handler, slack, telegram, settle } = setup();
    const created: FeedbackResponse = await (await handler.POST(post({ ...feedbackPayload, clientId: "n-2" }))).json();
    await settle();
    slack.calls.length = 0;
    telegram.calls.length = 0;

    await handler.PATCH(
      new Request(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ id: created.id, projectName: "acme", status: "resolved" }),
      }),
    );
    await handler.POST(
      post({
        projectName: "acme",
        feedbackId: created.id,
        body: "Thanks!",
        authorName: "Alice",
        authorEmail: "",
        authorRole: "client",
        clientId: "r-1",
      }),
    );
    await settle();

    const titles = slack.calls.map((call) => JSON.parse(call.body).blocks[0].text.text);
    expect(titles).toEqual(["Feedback resolved on acme", "Alice replied on acme"]);
    expect(telegram.calls).toHaveLength(0); // routed to `created` only
  });
});
