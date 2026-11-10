import { MemoryStore } from "@siteping/adapter-memory";
import { type FeedbackResponse, isSitepingConfigError, type SitepingStore } from "@siteping/core";
import { describe, expect, it, vi } from "vitest";
import { createSitepingHandler, type SitepingTeamEvent } from "../src/index.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "a-secret-key";
const BEARER = { Authorization: `Bearer ${API_KEY}` };
const PROJECT = validPayloadNoAnnotations.projectName;

function request(method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let clientIds = 0;
const nextClientId = () => `team-${++clientIds}`;

/** A handler over `store` whose `notifyTeam` records every call, its background work collected through `waitUntil`. */
function setup(store: SitepingStore = new MemoryStore(), notify = vi.fn()) {
  const logger = { error: vi.fn() };
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  const handler = createSitepingHandler({ store, apiKey: API_KEY, notifyTeam: notify, logger, waitUntil });
  const settle = async () => {
    await Promise.all(pending);
  };
  const create = async (clientId = nextClientId()): Promise<FeedbackResponse> =>
    (await handler.POST(request("POST", { ...validPayloadNoAnnotations, clientId }))).json();
  const patch = (id: string, status: string) =>
    handler.PATCH(request("PATCH", { id, projectName: PROJECT, status }, BEARER));
  const reply = (feedbackId: string, authorRole: "team" | "client", clientId = nextClientId()) =>
    handler.POST(
      request(
        "POST",
        {
          projectName: PROJECT,
          feedbackId,
          body: "Still broken on mobile",
          authorName: "Alice",
          authorEmail: "",
          authorRole,
          clientId,
        },
        authorRole === "team" ? BEARER : {},
      ),
    );
  const events = (): SitepingTeamEvent["type"][] =>
    notify.mock.calls.map(([, event]) => (event as SitepingTeamEvent).type);
  return { handler, notify, logger, waitUntil, settle, create, patch, reply, events };
}

describe("notifyTeam", () => {
  it("is told once per inserted feedback, never for a replayed clientId", async () => {
    const { notify, settle, create, waitUntil } = setup();
    const clientId = nextClientId();

    const feedback = await create(clientId);
    await create(clientId);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    const [record, event, context] = notify.mock.calls[0] ?? [];
    expect(record).toMatchObject({ id: feedback.id, authorEmail: "alice@example.com" });
    expect(event).toEqual({ type: "created" });
    expect(context.request).toBeInstanceOf(Request);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("is told about status changes that close or reopen, like notifyReporter", async () => {
    const { create, patch, settle, events } = setup();
    const feedback = await create();

    await patch(feedback.id, "in_progress");
    await patch(feedback.id, "resolved");
    await patch(feedback.id, "resolved");
    await patch(feedback.id, "open");
    await settle();

    expect(events()).toEqual(["created", "resolved", "reopened"]);
  });

  it("is told about every new reply, of either role, once", async () => {
    const { notify, create, reply, settle, events } = setup();
    const feedback = await create();

    const clientId = nextClientId();
    expect((await reply(feedback.id, "client", clientId)).status).toBe(201);
    expect((await reply(feedback.id, "client", clientId)).status).toBe(201); // a retried post
    expect((await reply(feedback.id, "team")).status).toBe(201);
    await settle();

    expect(events()).toEqual(["created", "replied", "replied"]);
    const roles = notify.mock.calls.slice(1).map(([, event]) => event.comment.authorRole);
    expect(roles).toEqual(["client", "team"]);
    expect(notify.mock.calls[1]?.[0]).toMatchObject({ id: feedback.id });
  });

  it("never holds the response: a notifier that never settles still lets the request answer", async () => {
    const { handler } = setup(
      new MemoryStore(),
      vi.fn(() => new Promise<void>(() => {})),
    );

    const response = await handler.POST(request("POST", { ...validPayloadNoAnnotations, clientId: nextClientId() }));

    expect(response.status).toBe(201);
  });

  it("logs a rejection, a synchronous throw and a throwing waitUntil, and still answers", async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error("Slack down"));
    notify.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    const { create, patch, settle, logger } = setup(new MemoryStore(), notify);

    const feedback = await create();
    expect((await patch(feedback.id, "resolved")).status).toBe(200);
    await settle();

    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Hook notifyTeam failed",
      expect.objectContaining({ feedbackId: feedback.id, event: "created" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Hook notifyTeam failed",
      expect.objectContaining({ feedbackId: feedback.id, event: "resolved" }),
    );

    const failing = createSitepingHandler({
      store: new MemoryStore(),
      apiKey: API_KEY,
      notifyTeam: () => {},
      logger,
      waitUntil: () => {
        throw new Error("no runtime");
      },
    });
    const response = await failing.POST(request("POST", { ...validPayloadNoAnnotations, clientId: nextClientId() }));
    expect(response.status).toBe(201);
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] waitUntil failed",
      expect.objectContaining({ event: "created" }),
    );
  });

  it("without it, a PATCH does not read the previous status", async () => {
    const store = new MemoryStore();
    const getFeedback = vi.spyOn(store, "getFeedback");
    const handler = createSitepingHandler({ store, apiKey: API_KEY });
    const created: FeedbackResponse = await (
      await handler.POST(request("POST", { ...validPayloadNoAnnotations, clientId: nextClientId() }))
    ).json();

    await handler.PATCH(request("PATCH", { id: created.id, projectName: PROJECT, status: "resolved" }, BEARER));

    expect(getFeedback).not.toHaveBeenCalled();
  });

  it("refuses a store with threads but no addCommentIfAbsent, which cannot tell a retried reply", () => {
    const store = new MemoryStore();
    const legacy = Object.assign(Object.create(store) as SitepingStore, { addCommentIfAbsent: undefined });
    let thrown: unknown;
    try {
      createSitepingHandler({ store: legacy, apiKey: API_KEY, notifyTeam: () => {} });
    } catch (error) {
      thrown = error;
    }
    expect(isSitepingConfigError(thrown) && thrown.code).toBe("CONFIG_NOTIFY_TEAM_UNSUPPORTED");
  });
});
