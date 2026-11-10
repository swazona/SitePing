import { MemoryStore } from "@siteping/adapter-memory";
import type { FeedbackRecord, FeedbackStatus, SitepingStore } from "@siteping/core";
import { createSitepingHandler } from "@siteping/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/core/webhook.js";
import { createIssueTrackerHooks, type IssueWebhookOptions } from "../src/index.js";
import { createClickUpTracker, createClickUpWebhookHandler } from "../src/providers/clickup.js";
import { createGitHubWebhookHandler } from "../src/providers/github.js";
import { createJiraTracker, createJiraWebhookHandler } from "../src/providers/jira.js";
import { createLinearTracker, createLinearWebhookHandler } from "../src/providers/linear.js";
import { createPlaneTracker, createPlaneWebhookHandler } from "../src/providers/plane.js";
import {
  createFakeClickUp,
  createFakeJira,
  createFakeLinear,
  createFakePlane,
  type SaasFake,
} from "./fake-saas-trackers.js";

const SECRET = "webhook-signing-secret";
const TOKEN = "tracker-secret-token";
const WEBHOOK = "http://localhost/api/siteping/webhooks";
const encoder = new TextEncoder();

const feedbackPayload = {
  projectName: "site",
  type: "bug" as const,
  message: "Broken",
  url: "/",
  viewport: "1280x720",
  userAgent: "Mozilla/5.0",
  authorName: "Alice",
  authorEmail: "alice@example.com",
  annotations: [],
};

let clientIds = 0;

/** A server whose hooks open issues on `tracker`, and a way to create feedbacks through it. */
function serverWith(store: SitepingStore, hooks?: ReturnType<typeof createIssueTrackerHooks>) {
  const handler = createSitepingHandler({
    store,
    apiKey: "k",
    ...(hooks ? { hooks } : {}),
    logger: { error: vi.fn() },
  });
  return async (): Promise<FeedbackRecord> => {
    clientIds += 1;
    const response = await handler.POST(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...feedbackPayload, clientId: `wh-${clientIds}` }),
      }),
    );
    return response.json();
  };
}

async function delivery(body: unknown, headers: (raw: string) => Promise<Record<string, string>>): Promise<Request> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(WEBHOOK, { method: "POST", headers: await headers(raw), body: raw });
}

const statusOf = async (store: MemoryStore, id: string): Promise<FeedbackStatus | undefined> =>
  (await store.getFeedback(id))?.status;

afterEach(() => {
  vi.useRealTimers();
});

interface SaasWebhookCase {
  name: string;
  createFake(): SaasFake;
  createTracker(fake: SaasFake): ReturnType<typeof createLinearTracker>;
  createHandler(
    tracker: ReturnType<typeof createLinearTracker>,
    options: IssueWebhookOptions,
  ): (request: Request) => Promise<Response>;
  /** The tracker-side state kinds meaning open, resolved and won't fix. */
  kinds: { open: string; resolved: string; wontFix: string };
  /** A delivery saying the issue's state changed, signed or not. */
  stateChange(key: string, sign: boolean): Promise<Request>;
  /** A delivery about something else on that issue. */
  otherChange(key: string): Promise<Request>;
}

const signWith =
  (header: string, prefix = "") =>
  async (raw: string) => ({
    "Content-Type": "application/json",
    [header]: `${prefix}${await hmacSha256Hex(SECRET, encoder.encode(raw))}`,
  });
const unsigned = async () => ({ "Content-Type": "application/json" });

const cases: SaasWebhookCase[] = [
  {
    name: "Linear",
    createFake: () => createFakeLinear(),
    createTracker: (fake) => createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch }),
    createHandler: (tracker, options) => createLinearWebhookHandler({ tracker, ...options }),
    kinds: { open: "unstarted", resolved: "completed", wontFix: "canceled" },
    stateChange: (key, sign) =>
      delivery(
        {
          action: "update",
          type: "Issue",
          data: { id: key, stateId: "whatever" },
          updatedFrom: { stateId: "previous", updatedAt: "2026-01-01T00:00:00.000Z" },
          webhookTimestamp: Date.now(),
        },
        sign ? signWith("Linear-Signature") : unsigned,
      ),
    otherChange: (key) =>
      delivery(
        {
          action: "update",
          type: "Issue",
          data: { id: key },
          updatedFrom: { title: "old" },
          webhookTimestamp: Date.now(),
        },
        signWith("Linear-Signature"),
      ),
  },
  {
    name: "Jira",
    createFake: () => createFakeJira(),
    createTracker: (fake) =>
      createJiraTracker({
        siteUrl: "https://acme.atlassian.net",
        projectKey: "WEB",
        email: "a@b.c",
        apiToken: TOKEN,
        fetch: fake.fetch,
      }),
    createHandler: (tracker, options) => createJiraWebhookHandler({ tracker, ...options }),
    kinds: { open: "new", resolved: "done", wontFix: "done" },
    stateChange: (key, sign) =>
      delivery(
        {
          webhookEvent: "jira:issue_updated",
          issue: { id: "1", key },
          changelog: { items: [{ field: "status", fromString: "To Do", toString: "Done" }] },
        },
        sign ? signWith("X-Hub-Signature", "sha256=") : unsigned,
      ),
    otherChange: (key) =>
      delivery(
        { webhookEvent: "jira:issue_updated", issue: { key }, changelog: { items: [{ field: "summary" }] } },
        signWith("X-Hub-Signature", "sha256="),
      ),
  },
  {
    name: "Plane",
    createFake: () => createFakePlane(),
    createTracker: (fake) =>
      createPlaneTracker({ workspaceSlug: "acme", projectId: "proj-1", apiKey: TOKEN, fetch: fake.fetch }),
    createHandler: (tracker, options) => createPlaneWebhookHandler({ tracker, ...options }),
    kinds: { open: "unstarted", resolved: "completed", wontFix: "cancelled" },
    stateChange: (key, sign) =>
      delivery(
        {
          version: "v2",
          event: "workitem.updated",
          entity_type: "issue",
          entity_id: key,
          data: { id: key, state_id: "x" },
          previous_attributes: { state_id: "y" },
        },
        sign ? signWith("X-Plane-Signature") : unsigned,
      ),
    otherChange: (key) =>
      delivery(
        { version: "v2", entity_type: "issue", entity_id: key, data: {}, previous_attributes: { name: "old" } },
        signWith("X-Plane-Signature"),
      ),
  },
  {
    name: "ClickUp",
    createFake: () => createFakeClickUp(),
    createTracker: (fake) =>
      createClickUpTracker({
        listId: "list-1",
        workspaceId: "ws-1",
        token: TOKEN,
        statuses: { wont_fix: "won't fix" },
        fetch: fake.fetch,
      }),
    createHandler: (tracker, options) => createClickUpWebhookHandler({ tracker, ...options }),
    kinds: { open: "to do", resolved: "complete", wontFix: "won't fix" },
    stateChange: (key, sign) => clickUpStatusDelivery(key, sign ? signWith("X-Signature") : unsigned),
    otherChange: (key) =>
      delivery(
        {
          event: "taskTagUpdated",
          task_id: key,
          webhook_id: "wh-1",
          history_items: [{ id: "h-2", field: "tag", after: [{ name: "x" }] }],
        },
        signWith("X-Signature"),
      ),
  },
];

/** A ClickUp `taskStatusUpdated` delivery, its payload claiming the task is complete whatever it is. */
function clickUpStatusDelivery(key: string, headers: (raw: string) => Promise<Record<string, string>>) {
  return delivery(
    {
      event: "taskStatusUpdated",
      task_id: key,
      webhook_id: "wh-1",
      history_items: [
        {
          id: "h-1",
          type: 1,
          date: "1642740510345",
          field: "status",
          before: { status: "to do", color: "#f9d900", orderindex: 0, type: "open" },
          after: { status: "complete", color: "#6bc950", orderindex: 3, type: "closed" },
        },
      ],
    },
    headers,
  );
}

for (const testCase of cases) {
  describe(`${testCase.name} webhook`, () => {
    async function setup(options: Partial<IssueWebhookOptions> = {}) {
      const fake = testCase.createFake();
      const tracker = testCase.createTracker(fake);
      const store = new MemoryStore();
      const create = serverWith(store, createIssueTrackerHooks({ tracker }));
      const onStatusSynced = vi.fn();
      const logger = { error: vi.fn() };
      const handle = testCase.createHandler(tracker, { secret: SECRET, store, onStatusSynced, logger, ...options });
      const feedback = await create();
      const issue = fake.issues[0] as SaasFake["issues"][number];
      return { fake, store, handle, feedback, issue, onStatusSynced, logger };
    }

    it("resolves the feedback when its issue is closed on the tracker, and reopens it", async () => {
      const { store, handle, feedback, issue, onStatusSynced } = await setup();

      issue.stateKind = testCase.kinds.resolved;
      const closed = await handle(await testCase.stateChange(issue.key, true));
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({ result: "updated", status: "resolved" });
      expect(await statusOf(store, feedback.id)).toBe("resolved");
      expect(onStatusSynced).toHaveBeenCalledWith(
        expect.objectContaining({ id: feedback.id, status: "resolved" }),
        expect.objectContaining({ tracker: testCase.name, previousStatus: "open", status: "resolved" }),
      );

      issue.stateKind = testCase.kinds.open;
      if (testCase.name === "Jira") issue.resolution = null;
      await handle(await testCase.stateChange(issue.key, true));
      expect(await statusOf(store, feedback.id)).toBe("open");
    });

    it("refuses a delivery without a valid signature, and changes nothing", async () => {
      const { store, handle, feedback, issue, fake } = await setup();
      issue.stateKind = testCase.kinds.resolved;
      const requestsBefore = fake.requests.length;

      const response = await handle(await testCase.stateChange(issue.key, false));
      const forged = await testCase.stateChange(issue.key, true);
      const tampered = new Request(forged, { body: (await forged.text()).replace(issue.key, `${issue.key} `) });

      expect(response.status).toBe(401);
      expect((await handle(tampered)).status).toBe(401);
      expect(await statusOf(store, feedback.id)).toBe("open");
      // Refused before the tracker is asked anything.
      expect(fake.requests.length).toBe(requestsBefore);
    });

    it("ignores an update that did not change the issue's state", async () => {
      const { store, handle, feedback, issue } = await setup();
      issue.stateKind = testCase.kinds.resolved;

      const response = await handle(await testCase.otherChange(issue.key));

      expect(await response.json()).toEqual({ result: "ignored", reason: "not an issue state change" });
      expect(await statusOf(store, feedback.id)).toBe("open");
    });

    it("leaves an in-progress feedback alone when its issue is reopened — the echo of its own sync", async () => {
      const { store, handle, feedback, issue } = await setup();
      await store.updateFeedback(feedback.id, { status: "in_progress", resolvedAt: null });

      const response = await handle(await testCase.stateChange(issue.key, true));

      expect(await response.json()).toEqual({ result: "ignored", reason: "feedback status already matches" });
      expect(await statusOf(store, feedback.id)).toBe("in_progress");
    });

    it("never lets an issue of another team or project change a feedback, label and marker notwithstanding", async () => {
      const { store, handle, feedback, issue, fake } = await setup();
      const tracker = testCase.createTracker(fake);
      const update = vi.spyOn(store, "updateFeedback");
      // Same `siteping` label, same valid marker, but it lives elsewhere in the tracker.
      issue.scope = testCase.name === "Jira" ? "OTHER" : "foreign-scope";
      issue.stateKind = testCase.kinds.resolved;

      const response = await handle(await testCase.stateChange(issue.key, true));

      expect(await response.json()).toEqual({ result: "ignored", reason: "not an issue state change" });
      expect(update).not.toHaveBeenCalled();
      expect(await statusOf(store, feedback.id)).toBe("open");
      expect(await tracker.getIssue(issue.key)).toBeNull();
      expect((await tracker.findSitepingIssues(`"id":"${feedback.id}"`)).issues).toEqual([]);
    });

    it("ignores an issue of another instance", async () => {
      const { store, handle, feedback, issue } = await setup({ instance: "staging" });
      issue.stateKind = testCase.kinds.resolved;

      const response = await handle(await testCase.stateChange(issue.key, true));

      expect(await response.json()).toEqual({ result: "ignored", reason: "issue belongs to another instance" });
      expect(await statusOf(store, feedback.id)).toBe("open");
    });

    it("answers 500 when the store fails, so the tracker retries", async () => {
      const { handle, issue, store, logger } = await setup();
      issue.stateKind = testCase.kinds.resolved;
      vi.spyOn(store, "updateFeedback").mockRejectedValue(new Error("db down"));

      const response = await handle(await testCase.stateChange(issue.key, true));

      expect(response.status).toBe(500);
      expect(logger.error).toHaveBeenCalledWith(`[siteping] ${testCase.name} webhook failed`, expect.anything());
    });
  });
}

describe("Linear webhook", () => {
  it("refuses a validly signed delivery older than the tolerance, against replays", async () => {
    const fake = createFakeLinear();
    const tracker = createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch });
    const handle = createLinearWebhookHandler({ tracker, secret: SECRET, store: new MemoryStore() });
    const stale = {
      action: "update",
      type: "Issue",
      data: { id: "x" },
      updatedFrom: { stateId: "y" },
      webhookTimestamp: Date.now() - 61_000,
    };

    expect((await handle(await delivery(stale, signWith("Linear-Signature")))).status).toBe(401);
  });

  it("maps a canceled issue to wont_fix", async () => {
    const fake = createFakeLinear();
    const tracker = createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch });
    const store = new MemoryStore();
    const feedback = await serverWith(store, createIssueTrackerHooks({ tracker }))();
    const handle = createLinearWebhookHandler({ tracker, secret: SECRET, store });
    const issue = fake.issues[0] as SaasFake["issues"][number];
    issue.stateKind = "canceled";

    await handle(await (cases[0] as SaasWebhookCase).stateChange(issue.key, true));

    expect(await statusOf(store, feedback.id)).toBe("wont_fix");
  });
});

describe("Jira webhook", () => {
  async function setup(secretHeader?: string) {
    const fake = createFakeJira();
    const tracker = createJiraTracker({
      siteUrl: "https://acme.atlassian.net",
      projectKey: "WEB",
      email: "a@b.c",
      apiToken: TOKEN,
      fetch: fake.fetch,
    });
    const store = new MemoryStore();
    const feedback = await serverWith(store, createIssueTrackerHooks({ tracker }))();
    const handle = createJiraWebhookHandler({
      tracker,
      secret: SECRET,
      store,
      ...(secretHeader ? { secretHeader } : {}),
    });
    return { fake, store, feedback, handle, issue: fake.issues[0] as SaasFake["issues"][number] };
  }
  const update = (key: string) => ({
    webhookEvent: "jira:issue_updated",
    issue: { key },
    changelog: { items: [{ field: "resolution" }] },
  });

  it("maps a won't-do resolution to wont_fix, and keeps a closed feedback's reason on a plain Done", async () => {
    const { store, feedback, handle, issue } = await setup();
    issue.stateKind = "done";
    issue.resolution = "Won't Do";

    await handle(await delivery(update(issue.key), signWith("X-Hub-Signature", "sha256=")));
    expect(await statusOf(store, feedback.id)).toBe("wont_fix");

    issue.resolution = "Done";
    const again = await handle(await delivery(update(issue.key), signWith("X-Hub-Signature", "sha256=")));
    expect(await again.json()).toMatchObject({ result: "ignored" });
    expect(await statusOf(store, feedback.id)).toBe("wont_fix");
  });

  it("verifies the signature with the documented WebSub example", async () => {
    // From Atlassian's webhook docs: secret "It's a Secret to Everybody", payload "Hello World!".
    expect(await hmacSha256Hex("It's a Secret to Everybody", encoder.encode("Hello World!"))).toBe(
      "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
    );
  });

  it("accepts the secret in a header only when told to, and never a wrong one", async () => {
    const plain = await setup();
    const withHeader = await setup("X-Automation-Secret");
    const headers = (secret: string) => async () => ({
      "Content-Type": "application/json",
      "X-Automation-Secret": secret,
    });
    plain.issue.stateKind = "done";
    withHeader.issue.stateKind = "done";

    expect((await plain.handle(await delivery(update(plain.issue.key), headers(SECRET)))).status).toBe(401);
    expect((await withHeader.handle(await delivery(update(withHeader.issue.key), headers("wrong")))).status).toBe(401);
    expect((await withHeader.handle(await delivery(update(withHeader.issue.key), headers(SECRET)))).status).toBe(200);
    expect(await statusOf(withHeader.store, withHeader.feedback.id)).toBe("resolved");
  });
});

describe("ClickUp webhook", () => {
  async function setup() {
    const fake = createFakeClickUp();
    const tracker = createClickUpTracker({ listId: "list-1", workspaceId: "ws-1", token: TOKEN, fetch: fake.fetch });
    const store = new MemoryStore();
    const feedback = await serverWith(store, createIssueTrackerHooks({ tracker }))();
    const handle = createClickUpWebhookHandler({ tracker, secret: SECRET, store, logger: { error: vi.fn() } });
    return { fake, store, feedback, handle, issue: fake.issues[0] as SaasFake["issues"][number] };
  }

  it("verifies the X-Signature HMAC of the raw body, any case, against the documented Node example", async () => {
    const { createHmac } = await import("node:crypto");
    const { store, feedback, handle, issue } = await setup();
    issue.stateKind = "complete";

    const response = await handle(
      await clickUpStatusDelivery(issue.key, async (raw) => ({
        "Content-Type": "application/json",
        "X-Signature": createHmac("sha256", SECRET).update(raw).digest("hex").toUpperCase(),
      })),
    );

    expect(await response.json()).toEqual({ result: "updated", status: "resolved" });
    expect(await statusOf(store, feedback.id)).toBe("resolved");
  });

  it("refuses a signature made with another secret, over other bytes, or cut short", async () => {
    const { store, feedback, handle, issue, fake } = await setup();
    issue.stateKind = "complete";
    const before = fake.requests.length;
    const update = vi.spyOn(store, "updateFeedback");
    const signed = (signature: (raw: string) => Promise<string>) =>
      clickUpStatusDelivery(issue.key, async (raw) => ({
        "Content-Type": "application/json",
        "X-Signature": await signature(raw),
      }));

    for (const request of [
      await signed((raw) => hmacSha256Hex("another-secret", encoder.encode(raw))),
      await signed((raw) => hmacSha256Hex(SECRET, encoder.encode(`${raw} `))),
      await signed(async (raw) => (await hmacSha256Hex(SECRET, encoder.encode(raw))).slice(0, 63)),
      await signed(async (raw) => `sha256=${await hmacSha256Hex(SECRET, encoder.encode(raw))}`),
    ]) {
      expect((await handle(request)).status).toBe(401);
    }
    expect(update).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(before);
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("reads the task's status through the tracker, not the delivery's", async () => {
    const { store, feedback, handle, issue } = await setup();
    // The delivery says "complete"; the task is still to do.
    const response = await handle(await clickUpStatusDelivery(issue.key, signWith("X-Signature")));

    expect(await response.json()).toEqual({ result: "ignored", reason: "feedback status already matches" });
    expect(issue.stateKind).toBe("to do");
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("never lets a task of another workspace change a feedback, and never writes the store", async () => {
    const { store, feedback, handle, issue } = await setup();
    const update = vi.spyOn(store, "updateFeedback");
    issue.workspace = "ws-2";
    issue.stateKind = "complete";

    const response = await handle(await clickUpStatusDelivery(issue.key, signWith("X-Signature")));

    expect(await response.json()).toEqual({ result: "ignored", reason: "not an issue state change" });
    expect(update).not.toHaveBeenCalled();
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("ignores a delivery naming no task id, or one that is no id, without asking ClickUp", async () => {
    const { handle, fake, store } = await setup();
    const update = vi.spyOn(store, "updateFeedback");
    const before = fake.requests.length;

    for (const taskId of [undefined, 12, "../list/list-1", { id: "cu1" }]) {
      const response = await handle(
        await delivery({ event: "taskStatusUpdated", task_id: taskId }, signWith("X-Signature")),
      );
      expect(await response.json()).toEqual({ result: "ignored", reason: "not an issue state change" });
    }
    expect(fake.requests).toHaveLength(before);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("Plane webhook", () => {
  it("reads the version 1 payload too", async () => {
    const fake = createFakePlane();
    const tracker = createPlaneTracker({
      workspaceSlug: "acme",
      projectId: "proj-1",
      apiKey: TOKEN,
      fetch: fake.fetch,
    });
    const store = new MemoryStore();
    const feedback = await serverWith(store, createIssueTrackerHooks({ tracker }))();
    const handle = createPlaneWebhookHandler({ tracker, secret: SECRET, store });
    const issue = fake.issues[0] as SaasFake["issues"][number];
    issue.stateKind = "completed";

    const legacy = { event: "issue", action: "updated", data: { id: issue.key }, activity: { field: "state" } };
    await handle(await delivery(legacy, signWith("X-Plane-Signature")));

    expect(await statusOf(store, feedback.id)).toBe("resolved");
  });
});

describe("GitHub webhook", () => {
  async function setup(options: Partial<IssueWebhookOptions> = {}) {
    const store = new MemoryStore();
    const feedback = await serverWith(store)();
    const handle = createGitHubWebhookHandler({ repository: "acme/site", secret: SECRET, store, ...options });
    const marker = `<!-- siteping-feedback {"id":"${feedback.id}","project":"site"} -->`;
    const event = (overrides: Record<string, unknown> = {}, issue: Record<string, unknown> = {}) => ({
      action: "closed",
      repository: { full_name: "Acme/Site" },
      issue: {
        number: 12,
        html_url: "https://github.com/acme/site/issues/12",
        body: `${marker}\n\n## Message`,
        state: "closed",
        state_reason: "completed",
        labels: [{ name: "SitePing" }],
        ...issue,
      },
      ...overrides,
    });
    const send = async (
      body: unknown,
      eventName = "issues",
      sign: (raw: string) => Promise<Record<string, string>> = signWith("X-Hub-Signature-256", "sha256="),
    ) => {
      const request = await delivery(body, async (raw) => ({ ...(await sign(raw)), "X-GitHub-Event": eventName }));
      return handle(request);
    };
    return { store, feedback, event, send };
  }

  it("resolves on closed as completed, wont_fix on not planned, open on reopened", async () => {
    const { store, feedback, event, send } = await setup();

    expect(await (await send(event())).json()).toEqual({ result: "updated", status: "resolved" });
    await send(event({}, { state_reason: "not_planned" }));
    expect(await statusOf(store, feedback.id)).toBe("wont_fix");
    await send(event({ action: "reopened" }, { state: "open", state_reason: "reopened" }));
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("refuses a bad or missing signature", async () => {
    const { store, feedback, event, send } = await setup();
    const wrongSecret = async (raw: string) => ({
      "X-Hub-Signature-256": `sha256=${await hmacSha256Hex("other", encoder.encode(raw))}`,
    });

    expect((await send(event(), "issues", wrongSecret)).status).toBe(401);
    expect((await send(event(), "issues", unsigned)).status).toBe(401);
    // GitHub's older SHA-1 header alone is not enough.
    expect((await send(event(), "issues", signWith("X-Hub-Signature", "sha1="))).status).toBe(401);
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("ignores pings, pull requests, other repositories and issues without the siteping label", async () => {
    const { store, feedback, event, send } = await setup();

    expect(await (await send({ zen: "Keep it logically awesome." }, "ping")).json()).toMatchObject({
      result: "ignored",
    });
    await send(event({}, { pull_request: {} }));
    await send(event({ repository: { full_name: "evil/site" } }));
    // An outsider's issue carrying a copied marker cannot carry the label.
    await send(event({}, { labels: [{ name: "bug" }] }));
    await send(event({ action: "labeled" }));

    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("never lets another repository's labelled, marked issue change a feedback", async () => {
    const { store, feedback, event, send } = await setup();
    const update = vi.spyOn(store, "updateFeedback");

    for (const full_name of ["evil/site", "acme/site-fork", "acme/site/x", ""]) {
      const response = await send(event({ repository: { full_name } }));
      expect(await response.json()).toEqual({ result: "ignored", reason: "not an issue state change" });
    }
    await send(event({ repository: undefined }));

    expect(update).not.toHaveBeenCalled();
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("only trusts the marker on the body's first line, and the project it names", async () => {
    const { store, feedback, event, send } = await setup();
    const marker = `<!-- siteping-feedback {"id":"${feedback.id}","project":"site"} -->`;

    const quoted = await send(event({}, { body: `Hello\n\n${marker}` }));
    const otherProject = await send(event({}, { body: marker.replace('"site"', '"other"') }));

    expect(await quoted.json()).toEqual({ result: "ignored", reason: "issue is not linked to a feedback" });
    expect(await otherProject.json()).toEqual({ result: "ignored", reason: "feedback not found" });
    expect(await statusOf(store, feedback.id)).toBe("open");
  });

  it("logs a throwing onStatusSynced and still succeeds", async () => {
    const logger = { error: vi.fn() };
    const { event, send } = await setup({ logger, onStatusSynced: () => Promise.reject(new Error("smtp")) });

    expect((await send(event())).status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith("[siteping] GitHub webhook: onStatusSynced failed", expect.anything());
  });

  it("answers 405 to other methods, 400 to a signed body that is not JSON, 413 past maxBodyBytes", async () => {
    const { send } = await setup();
    const small = createGitHubWebhookHandler({
      repository: "acme/site",
      secret: SECRET,
      store: new MemoryStore(),
      maxBodyBytes: 10,
    });

    expect((await small(new Request(WEBHOOK))).status).toBe(405);
    expect((await send("not json")).status).toBe(400);
    expect((await small(await delivery({ a: "long enough" }, signWith("X-Hub-Signature-256", "sha256=")))).status).toBe(
      413,
    );
  });

  it("works without getFeedback, mapping each state change as is", async () => {
    const memory = new MemoryStore();
    const feedback = await serverWith(memory)();
    const store = {
      updateFeedback: memory.updateFeedback.bind(memory),
      verifyProjectOwnership: memory.verifyProjectOwnership.bind(memory),
    };
    const handle = createGitHubWebhookHandler({ repository: "acme/site", secret: SECRET, store });
    const body = {
      action: "closed",
      repository: { full_name: "acme/site" },
      issue: {
        number: 1,
        html_url: "https://github.com/acme/site/issues/1",
        body: `<!-- siteping-feedback {"id":"${feedback.id}","project":"site"} -->`,
        state: "closed",
        state_reason: null,
        labels: ["siteping"],
      },
    };
    const sign = async (raw: string) => ({
      ...(await signWith("X-Hub-Signature-256", "sha256=")(raw)),
      "X-GitHub-Event": "issues",
    });

    expect(await (await handle(await delivery(body, sign))).json()).toEqual({ result: "updated", status: "resolved" });
  });

  it("refuses an empty secret or a malformed repository when it is created", () => {
    const store = new MemoryStore();
    expect(() => createGitHubWebhookHandler({ repository: "acme/site", secret: "", store })).toThrow(
      /secret must be a non-empty string/,
    );
    expect(() => createGitHubWebhookHandler({ repository: "acme", secret: SECRET, store })).toThrow(/owner\/name/);
  });
});
