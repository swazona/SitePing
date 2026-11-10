import { describe, expect, it } from "vitest";
import { buildWhatsAppText, createWhatsAppChannel, toTemplateParameter } from "../src/channels/whatsapp.js";
import { message, mockFetch, sendContext } from "./fixtures.js";

const TOKEN = "EAAGsecretAccessToken0123456789";
const base = { accessToken: TOKEN, phoneNumberId: "1234567890", to: "+33612345678" };

describe("WhatsApp channel", () => {
  it("sends a text message through the Cloud API, previews off", async () => {
    const { fetch, calls } = mockFetch(Response.json({ messages: [{ id: "wamid.1" }] }));
    const channel = createWhatsAppChannel({ ...base, fetch });

    await channel.send(message(), sendContext());

    expect(calls[0]?.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "33612345678",
      type: "text",
      text: {
        preview_url: false,
        body:
          "*New bug on acme*\n\nThe checkout button does nothing\n\nProject: acme\nPage: /checkout\n\n" +
          "Screenshot: https://cdn.acme.com/shots/1.jpg",
      },
    });
  });

  it("sends an approved template, its variables flattened for WhatsApp's rules", async () => {
    const { fetch, calls } = mockFetch(Response.json({ messages: [{ id: "wamid.2" }] }));
    const channel = createWhatsAppChannel({
      ...base,
      apiVersion: "v24.0",
      template: { name: "siteping_feedback", language: "fr", parameters: (m) => [m.projectName, m.summary] },
      fetch,
    });

    await channel.send(message({ summary: "line one\nline\ttwo          spaced" }), sendContext());

    expect(calls[0]?.url).toBe("https://graph.facebook.com/v24.0/1234567890/messages");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      type: "template",
      template: {
        name: "siteping_feedback",
        language: { code: "fr" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "acme" },
              { type: "text", text: "line one line two spaced" },
            ],
          },
        ],
      },
    });
    expect(toTemplateParameter("x".repeat(5000))).toHaveLength(1024);
    expect(toTemplateParameter("   ")).toBe("-");
    expect(toTemplateParameter("a      b")).not.toMatch(/\s{5,}/);
  });

  it("keeps a text body within 4096 characters and without invisible characters", () => {
    const body = buildWhatsAppText(message({ summary: `\u202E${"x".repeat(10_000)}`, title: "t\u200B".repeat(400) }));
    expect(body.length).toBeLessThanOrEqual(4096);
    expect(body).not.toMatch(/[\u200B\u202E]/);
  });

  it("reports Meta's error, the 24-hour window refusal included, as not retryable", async () => {
    const channel = createWhatsAppChannel({
      ...base,
      fetch: mockFetch(
        Response.json(
          { error: { message: "Re-engagement message", type: "OAuthException", code: 131047 } },
          { status: 400 },
        ),
      ).fetch,
    });
    const error = await channel.send(message(), sendContext()).catch((e: unknown) => e);
    expect(error).toMatchObject({
      channel: "whatsapp",
      status: 400,
      retryable: false,
      detail: "131047: Re-engagement message",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("fails a throwing template parameter builder once, without retry", async () => {
    const channel = createWhatsAppChannel({
      ...base,
      template: {
        name: "t",
        language: "en_US",
        parameters: () => {
          throw new Error("bad");
        },
      },
      fetch: mockFetch().fetch,
    });
    await expect(channel.send(message(), sendContext())).rejects.toMatchObject({ retryable: false });
  });

  it("refuses malformed ids, numbers, versions and tokens, never echoing the token", () => {
    expect(() => createWhatsAppChannel({ ...base, phoneNumberId: "123/../../me" })).toThrow(/phoneNumberId/);
    expect(() => createWhatsAppChannel({ ...base, to: "06 12 34 56 78" })).toThrow(/to/);
    expect(() => createWhatsAppChannel({ ...base, apiVersion: "latest" })).toThrow(/apiVersion/);
    expect(() => createWhatsAppChannel({ ...base, accessToken: `${TOKEN}\r\nX-Evil: 1` })).toThrow(
      /^(?!.*secretAccess)/s,
    );
    expect(() => createWhatsAppChannel({ ...base, template: { name: "Bad Name", language: "en" } })).toThrow(
      /template/,
    );
  });
});
