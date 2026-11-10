import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWebhookChannel, signNotification, verifyNotificationSignature } from "../src/channels/webhook.js";
import { message, mockFetch, sendContext } from "./fixtures.js";

const SECRET = "whsec_0123456789abcdef0123456789abcdef";
const URL_ = "https://n8n.acme.com/webhook/siteping";

describe("webhook channel", () => {
  it("posts the message as JSON with a verifiable HMAC-SHA256 signature", async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 204 }));
    const channel = createWebhookChannel({ url: URL_, secret: SECRET, headers: { Authorization: "Basic abc" }, fetch });

    await channel.send(message(), sendContext());

    const { body, headers, url } = calls[0] ?? { body: "", headers: new Headers(), url: "" };
    expect(url).toBe(URL_);
    expect(JSON.parse(body)).toEqual({
      type: "siteping.notification",
      version: 1,
      deliveryId: "created:fb_1:2026-11-10T10:00:00.000Z",
      message: message(),
    });
    expect(headers.get("x-siteping-event")).toBe("created");
    expect(headers.get("x-siteping-delivery")).toBe("created:fb_1:2026-11-10T10:00:00.000Z");
    expect(headers.get("authorization")).toBe("Basic abc");
    const timestamp = headers.get("x-siteping-timestamp") ?? "";
    const signature = headers.get("x-siteping-signature") ?? "";
    // The documented scheme, recomputed with Node's own HMAC.
    expect(signature).toBe(`sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`);
    await expect(verifyNotificationSignature({ secret: SECRET, body, signature, timestamp })).resolves.toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and malformed headers", async () => {
    const body = JSON.stringify({ hello: "world" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signNotification(SECRET, timestamp, body);
    const verify = (overrides: Partial<Parameters<typeof verifyNotificationSignature>[0]>) =>
      verifyNotificationSignature({ secret: SECRET, body, signature, timestamp, ...overrides });

    await expect(verify({})).resolves.toBe(true);
    await expect(verify({ body: new TextEncoder().encode(body) })).resolves.toBe(true);
    await expect(verify({ body: `${body} ` })).resolves.toBe(false);
    await expect(verify({ secret: `${SECRET}x` })).resolves.toBe(false);
    await expect(verify({ now: Date.now() + 301_000 })).resolves.toBe(false);
    await expect(verify({ now: Date.now() + 301_000, toleranceSeconds: 600 })).resolves.toBe(true);
    await expect(verify({ signature: signature.toUpperCase() })).resolves.toBe(false);
    await expect(verify({ signature: signature.slice(7) })).resolves.toBe(false);
    await expect(verify({ signature: "sha256=zz" })).resolves.toBe(false);
    await expect(verify({ signature: null })).resolves.toBe(false);
    await expect(verify({ timestamp: "12.5" })).resolves.toBe(false);
    await expect(verify({ timestamp: String(Number(timestamp) + 1) })).resolves.toBe(false);
  });

  it("shapes the body for another receiver, Discord with mentions off for instance", async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 204 }));
    const channel = createWebhookChannel({
      url: "https://discord.com/api/webhooks/1/SECRET",
      secret: SECRET,
      body: (m) => ({ content: `**${m.title}**\n${m.summary}`, allowed_mentions: { parse: [] } }),
      fetch,
    });
    await channel.send(message(), sendContext());
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      content: "**New bug on acme**\nThe checkout button does nothing",
      allowed_mentions: { parse: [] },
    });
  });

  it("reports a refusal by status only, never the receiver's answer nor the URL", async () => {
    const channel = createWebhookChannel({
      url: "https://receiver.example/hook?token=SECRET",
      secret: SECRET,
      fetch: mockFetch(new Response("echo: Authorization: Basic SECRET", { status: 503 })).fetch,
    });
    const error = await channel.send(message(), sendContext()).catch((e: unknown) => e);
    expect(error).toMatchObject({ channel: "webhook", status: 503, retryable: true, detail: undefined });
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("refuses an insecure URL, a short secret and reserved or malformed headers", () => {
    expect(() => createWebhookChannel({ url: "http://10.0.0.1/hook", secret: SECRET })).toThrow(/https/);
    expect(() => createWebhookChannel({ url: URL_, secret: "short" })).toThrow(/32/);
    expect(() => createWebhookChannel({ url: URL_, secret: SECRET, headers: { "X-Siteping-Signature": "x" } })).toThrow(
      /reserved/,
    );
    expect(() => createWebhookChannel({ url: URL_, secret: SECRET, headers: { "X-A": "1\r\nX-B: 2" } })).toThrow(
      /malformed/,
    );
  });
});
