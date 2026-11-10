import { describe, expect, it } from "vitest";
import { fitEscaped, oneLine, textBlock, truncate } from "../src/core/text.js";
import { buildNotificationMessage, NOTIFICATION_STRINGS } from "../src/index.js";
import { feedbackRecord, INVISIBLES, reply } from "./fixtures.js";

describe("text hygiene", () => {
  it("flattens every line terminator and drops invisible and bidi control characters", () => {
    expect(oneLine(`a\r\nb\u2028c\u2029d\u0085e\vf${INVISIBLES}g`)).toBe("a b c d e fg");
    expect(textBlock(`one\r\n\r\n\r\n\r\ntwo\u2028three${INVISIBLES}`)).toBe("one\n\ntwo\nthree");
  });

  it("truncates on UTF-16 length without splitting a surrogate pair", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    const cut = truncate("😀😀😀", 4);
    expect(cut).toBe("😀…");
    expect(cut.length).toBeLessThanOrEqual(4);
    expect(truncate("abc", 0)).toBe("");
  });

  it("fits the escaped text without splitting an entity", () => {
    const escapeAmp = (text: string) => text.replace(/&/g, "&amp;");
    const out = fitEscaped("&&&&&&&&&&", 12, escapeAmp);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).toMatch(/^(&amp;)*…$/);
  });
});

describe("buildNotificationMessage", () => {
  it("builds a created message with fields and links", () => {
    const message = buildNotificationMessage(
      feedbackRecord({
        flowStep: 2,
        flowTitle: "Checkout",
        diagnostics: {
          console: [],
          network: [],
          components: ["App", "Layout", "Shop", "Cart", "Checkout", "Summary", "PayButton"],
          recording: { url: "https://cdn.acme.com/rec/1.webm", mimeType: "video/webm", durationMs: 1000, bytes: 10 },
        },
      }),
      { type: "created" },
      { siteUrl: "https://acme.com", dashboardUrl: (feedback) => `https://admin.acme.com/inbox/${feedback.id}` },
    );

    expect(message).toMatchObject({
      event: "created",
      feedbackId: "fb_1",
      projectName: "acme",
      title: "New bug on acme",
      summary: "The checkout button does nothing",
      occurredAt: "2026-11-10T10:00:00.000Z",
      locale: "en",
    });
    expect(Object.fromEntries(message.fields.map((field) => [field.key, field.value]))).toEqual({
      project: "acme",
      type: "bug",
      page: "/checkout?step=2",
      reporter: "Alice",
      flow: "Step 2 of Checkout",
      component: "Layout › Shop › Cart › Checkout › Summary › PayButton",
    });
    expect(Object.fromEntries(message.links.map((link) => [link.key, link.url]))).toEqual({
      page: "https://acme.com/checkout?step=2&siteping=fb_1",
      screenshot: "https://cdn.acme.com/shots/1.jpg",
      recording: "https://cdn.acme.com/rec/1.webm",
      dashboard: "https://admin.acme.com/inbox/fb_1",
    });
  });

  it("titles status changes and replies, with the status and the reply's author", () => {
    const record = feedbackRecord({ status: "wont_fix" });
    expect(buildNotificationMessage(record, { type: "resolved", status: "wont_fix" }).title).toBe(
      "Feedback closed as won't fix on acme",
    );
    const resolved = buildNotificationMessage(feedbackRecord({ status: "resolved" }), {
      type: "resolved",
      status: "resolved",
    });
    expect(resolved.title).toBe("Feedback resolved on acme");
    expect(resolved.fields.find((field) => field.key === "status")?.value).toBe("Resolved");
    expect(resolved.occurredAt).toBe("2026-11-10T11:00:00.000Z");

    const replied = buildNotificationMessage(feedbackRecord(), { type: "replied", comment: reply() });
    expect(replied).toMatchObject({
      title: "Alice replied on acme",
      summary: "Still broken on mobile",
      reply: { authorName: "Alice", authorRole: "client" },
      occurredAt: "2026-11-10T12:00:00.000Z",
    });
    expect(replied.fields.find((field) => field.key === "author")?.value).toBe("Alice (reporter)");
  });

  it("speaks every built-in locale, and takes overrides", () => {
    const fr = buildNotificationMessage(feedbackRecord(), { type: "created" }, { locale: "fr" });
    expect(fr.title).toBe("Nouveau retour (bug) sur acme");
    expect(fr.fields[0]).toEqual({ key: "project", label: "Projet", value: "acme" });
    for (const locale of Object.keys(NOTIFICATION_STRINGS) as Array<keyof typeof NOTIFICATION_STRINGS>) {
      const message = buildNotificationMessage(feedbackRecord(), { type: "created" }, { locale });
      expect(message.title).toContain("acme");
      expect(message.title).not.toMatch(/\{\w+\}/);
    }
    const custom = buildNotificationMessage(
      feedbackRecord(),
      { type: "created" },
      { strings: { titleCreated: "🐞 {project}" } },
    );
    expect(custom.title).toBe("🐞 acme");
  });

  it("redacts secrets by default, emails on request, and never shows the reporter's email unless asked", () => {
    const record = feedbackRecord({
      message: "Token sk_live_abcdefghijklmnop leaked, mail bob@example.com",
      url: "/reset?token=hunter2hunter2",
    });
    const message = buildNotificationMessage(record, { type: "created" });
    expect(message.summary).toBe("Token [secret] leaked, mail bob@example.com");
    expect(message.fields.find((field) => field.key === "page")?.value).toBe("/reset?token=[secret]");
    expect(message.fields.find((field) => field.key === "reporter")?.value).toBe("Alice");

    const strict = buildNotificationMessage(
      record,
      { type: "created" },
      { redact: { emails: true }, includeAuthorEmail: true },
    );
    expect(strict.summary).toBe("Token [secret] leaked, mail [email]");
    expect(strict.fields.find((field) => field.key === "reporter")?.value).toBe("Alice <[email]>");

    const none = buildNotificationMessage(record, { type: "created" }, { redact: false, includeAuthorEmail: true });
    expect(none.summary).toContain("sk_live_abcdefghijklmnop");
    expect(none.fields.find((field) => field.key === "reporter")?.value).toBe("Alice <alice@example.com>");
  });

  it("cleans invisible and bidi characters from every text, redaction off included", () => {
    const record = feedbackRecord({
      projectName: `ac${INVISIBLES}me`,
      authorName: `\u202EecilA`,
      message: `Pay\u2066 now\u2069`,
    });
    const message = buildNotificationMessage(record, { type: "created" }, { redact: false });
    const texts = [message.title, message.summary, ...message.fields.map((field) => field.value)].join("|");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone is the point
    expect(texts).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/);
    expect(message.projectName).toBe("acme");
  });

  it("links the page only on the site's own origin, and never a script or data URL", () => {
    const keys = (url: string, siteUrl?: string) =>
      buildNotificationMessage(
        feedbackRecord({ url, screenshotUrl: null }),
        { type: "created" },
        { siteUrl },
      ).links.map((link) => link.url);
    expect(keys("/pricing")).toEqual([]); // no siteUrl: shown, never linked
    expect(keys("https://evil.example/phish", "https://acme.com")).toEqual([]);
    expect(keys("javascript:alert(1)", "https://acme.com")).toEqual([]);
    expect(keys("https://user:pw@acme.com/a", "https://acme.com")).toEqual(["https://acme.com/a?siteping=fb_1"]);

    const inline = buildNotificationMessage(
      feedbackRecord({ screenshotUrl: "data:image/jpeg;base64,AAAA" }),
      { type: "created" },
      { dashboardUrl: () => "javascript:alert(1)" },
    );
    expect(inline.links).toEqual([]);

    const noDeepLink = buildNotificationMessage(
      feedbackRecord({ url: "/pricing", screenshotUrl: null }),
      { type: "created" },
      { siteUrl: "https://acme.com", deepLinkParam: false },
    );
    expect(noDeepLink.links.map((link) => link.url)).toEqual(["https://acme.com/pricing"]);
  });

  it("bounds the summary and every field", () => {
    const message = buildNotificationMessage(
      feedbackRecord({ message: "x".repeat(10_000), authorName: "y".repeat(2000) }),
      { type: "created" },
    );
    expect(message.summary.length).toBeLessThanOrEqual(3000);
    for (const field of message.fields) expect(field.value.length).toBeLessThanOrEqual(500);
  });
});
