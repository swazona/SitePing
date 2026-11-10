import { MemoryStore } from "@siteping/adapter-memory";
import { type FeedbackResponse, isSitepingConfigError, type SitepingStore } from "@siteping/core";
import { describe, expect, it, vi } from "vitest";
import { createSitepingHandler, type SitepingReporterEvent } from "../src/index.js";
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
const nextClientId = () => `reporter-${++clientIds}`;

/** A handler over `store` whose `notifyReporter` records every call. */
function setup(store: SitepingStore = new MemoryStore(), notify = vi.fn()) {
  const logger = { error: vi.fn() };
  const handler = createSitepingHandler({ store, apiKey: API_KEY, notifyReporter: notify, logger });
  const create = async (): Promise<FeedbackResponse> =>
    (await handler.POST(request("POST", { ...validPayloadNoAnnotations, clientId: nextClientId() }))).json();
  const patch = (id: string, status: string) =>
    handler.PATCH(request("PATCH", { id, projectName: PROJECT, status }, BEARER));
  const reply = (feedbackId: string, authorRole: "team" | "client", clientId = nextClientId()) =>
    handler.POST(
      request(
        "POST",
        {
          projectName: PROJECT,
          feedbackId,
          body: "Fixed in today's deploy",
          authorName: "Team",
          authorEmail: "",
          authorRole,
          clientId,
        },
        authorRole === "team" ? BEARER : {},
      ),
    );
  const events = (): SitepingReporterEvent["type"][] =>
    notify.mock.calls.map(([, event]) => (event as SitepingReporterEvent).type);
  return { handler, notify, logger, create, patch, reply, events };
}

/** The memory store without `getFeedback`, like a store that predates it. */
function storeWithoutGetFeedback(): SitepingStore {
  const store = new MemoryStore();
  return new Proxy(store, {
    get: (target, property) =>
      property === "getFeedback" ? undefined : Reflect.get(target, property, target).bind?.(target),
    has: (target, property) => property !== "getFeedback" && Reflect.has(target, property),
  }) as SitepingStore;
}

describe("notifyReporter", () => {
  it("is told when a feedback is resolved, with the stored record and the request", async () => {
    const { notify, create, patch } = setup();
    const feedback = await create();

    expect((await patch(feedback.id, "resolved")).status).toBe(200);

    expect(notify).toHaveBeenCalledTimes(1);
    const [record, event, context] = notify.mock.calls[0] ?? [];
    expect(record).toMatchObject({ id: feedback.id, status: "resolved", authorEmail: "alice@example.com" });
    expect(event).toEqual({ type: "resolved", status: "resolved" });
    expect(context.request).toBeInstanceOf(Request);
  });

  it("with getFeedback, notifies only changes that cross between open and closed or change the close reason", async () => {
    const { create, patch, events } = setup();
    const feedback = await create();

    await patch(feedback.id, "in_progress"); // open → open: nothing to tell
    await patch(feedback.id, "resolved");
    await patch(feedback.id, "resolved"); // same status again
    await patch(feedback.id, "wont_fix"); // close reason changed
    await patch(feedback.id, "in_progress"); // reopened, into progress

    expect(events()).toEqual(["resolved", "resolved", "reopened"]);
  });

  it("without getFeedback, counts every PATCH to a closed status or to open", async () => {
    const { create, patch, events } = setup(storeWithoutGetFeedback());
    const feedback = await create();

    await patch(feedback.id, "in_progress");
    await patch(feedback.id, "resolved");
    await patch(feedback.id, "resolved");
    await patch(feedback.id, "open");

    expect(events()).toEqual(["resolved", "resolved", "reopened"]);
  });

  it("is told about each new team reply, once, and never about the reporter's own", async () => {
    const { notify, create, reply, events } = setup();
    const feedback = await create();

    expect((await reply(feedback.id, "client")).status).toBe(201);
    const clientId = nextClientId();
    expect((await reply(feedback.id, "team", clientId)).status).toBe(201);
    expect((await reply(feedback.id, "team", clientId)).status).toBe(201); // a retried post

    expect(events()).toEqual(["replied"]);
    const [record, event] = notify.mock.calls[0] ?? [];
    expect(record).toMatchObject({ id: feedback.id, authorEmail: "alice@example.com" });
    expect(event).toMatchObject({ type: "replied", comment: { authorRole: "team", projectName: PROJECT } });
  });

  it("finds a reply's feedback among the project's newest without getFeedback", async () => {
    const { create, reply, events, notify } = setup(storeWithoutGetFeedback());
    const feedback = await create();
    await create();

    await reply(feedback.id, "team");

    expect(events()).toEqual(["replied"]);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ id: feedback.id });
  });

  it("logs a throw and still answers the request", async () => {
    const { notify, logger, create, patch } = setup();
    notify.mockRejectedValue(new Error("SMTP down"));
    const feedback = await create();

    const response = await patch(feedback.id, "resolved");

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Hook notifyReporter failed",
      expect.objectContaining({ feedbackId: feedback.id, event: "resolved" }),
    );
  });

  it("refuses a store with threads but no addCommentIfAbsent, which cannot tell a retried reply", () => {
    const store = new MemoryStore();
    const legacy = Object.assign(Object.create(store) as SitepingStore, { addCommentIfAbsent: undefined });
    let thrown: unknown;
    try {
      createSitepingHandler({ store: legacy, apiKey: API_KEY, notifyReporter: () => {} });
    } catch (error) {
      thrown = error;
    }
    expect(isSitepingConfigError(thrown) && thrown.code).toBe("CONFIG_NOTIFY_REPORTER_UNSUPPORTED");
  });
});
