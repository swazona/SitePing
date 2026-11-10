import { describe, expect, it, vi } from "vitest";
import { buildEmailContent, createEmailChannel, type NotificationEmail } from "../src/channels/email.js";
import { message, sendContext } from "./fixtures.js";

describe("email channel", () => {
  it("hands the transport a text and an HTML body, to the configured recipients", async () => {
    const send = vi.fn(async (_mail: NotificationEmail) => ({ messageId: "1" }));
    const channel = createEmailChannel({
      send,
      to: ["team@acme.com", "lead@acme.com"],
      from: "SitePing <feedback@acme.com>",
      subjectPrefix: "[acme]",
    });

    await channel.send(message(), sendContext());

    const mail = send.mock.calls[0]?.[0];
    expect(mail).toMatchObject({
      to: ["team@acme.com", "lead@acme.com"],
      from: "SitePing <feedback@acme.com>",
      subject: "[acme] New bug on acme",
      headers: { "X-Siteping-Event": "created", "X-Siteping-Feedback": "fb_1" },
    });
    expect(mail?.text).toBe(
      "New bug on acme\n\nThe checkout button does nothing\n\nProject: acme\nPage: /checkout\n\n" +
        "Screenshot: https://cdn.acme.com/shots/1.jpg",
    );
    expect(mail?.html).toContain('<a href="https://cdn.acme.com/shots/1.jpg">Screenshot</a>');
    expect(mail?.html).toContain("<blockquote");
  });

  it("escapes every value in the HTML body and keeps the subject on one line", () => {
    const content = buildEmailContent(
      message({
        title: "Hi\r\nBcc: victim@example.com",
        summary: "<img src=x onerror=alert(1)> & 'quoted' \"double\"",
        fields: [{ key: "reporter", label: "Reporter", value: "<script>alert(1)</script>" }],
        links: [
          { key: "page", label: "Open", url: 'https://acme.com/?q="><svg onload=alert(1)>' },
          { key: "evil", label: "Evil", url: "javascript:alert(1)" },
        ],
      }),
    );
    expect(content.subject).toBe("Hi Bcc: victim@example.com");
    expect(content.subject).not.toMatch(/[\r\n]/);
    expect(content.html).not.toMatch(/<img|<script|<svg|javascript:/);
    expect(content.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quoted&#39; &quot;double&quot;");
    expect(content.html).toContain('href="https://acme.com/?q=&quot;&gt;&lt;svg onload=alert(1)&gt;"');
    expect(content.text).not.toContain("javascript:");
  });

  it("lets a transport failure through to the dispatcher, which retries it", async () => {
    const channel = createEmailChannel({ to: "team@acme.com", send: () => Promise.reject(new Error("SMTP 451")) });
    await expect(channel.send(message(), sendContext())).rejects.toThrow("SMTP 451");
  });

  it("refuses recipients and senders that could add addresses or headers", () => {
    const send = () => {};
    expect(() => createEmailChannel({ send, to: [] })).toThrow(/at least one/);
    expect(() => createEmailChannel({ send, to: "a@acme.com, b@evil.com" })).toThrow(/`to`/);
    expect(() => createEmailChannel({ send, to: "a@acme.com\r\nBcc: b@evil.com" })).toThrow(/`to`/);
    expect(() => createEmailChannel({ send, to: "a@acme.com", from: "x <a@acme.com>\nBcc: b@evil.com" })).toThrow(
      /`from`/,
    );
    expect(() => createEmailChannel({ to: "a@acme.com" } as never)).toThrow(/send/);
  });
});
