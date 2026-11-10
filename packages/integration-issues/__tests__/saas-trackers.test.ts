import { MemoryStore } from "@siteping/adapter-memory";
import type { FeedbackResponse } from "@siteping/core";
import { createSitepingHandler } from "@siteping/server";
import { describe, expect, it, vi } from "vitest";
import { createIssueTrackerHooks, type ReadableIssueTracker } from "../src/index.js";
import { createClickUpTracker } from "../src/providers/clickup.js";
import { createJiraTracker } from "../src/providers/jira.js";
import { createLinearTracker } from "../src/providers/linear.js";
import { createPlaneTracker } from "../src/providers/plane.js";
import {
  createFakeClickUp,
  createFakeJira,
  createFakeLinear,
  createFakePlane,
  type SaasFake,
} from "./fake-saas-trackers.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "server-key";
const TOKEN = "tracker-secret-token";

const payload = {
  projectName: "site",
  type: "bug" as const,
  message: "Checkout fails <b>@here</b> `rm -rf`",
  url: "/checkout",
  viewport: "1280x720",
  userAgent: "Mozilla/5.0",
  authorName: "Alice",
  authorEmail: "alice@example.com",
  annotations: [],
  screenshotUrl: undefined,
};

interface ProviderUnderTest {
  name: string;
  createFake(): SaasFake;
  createTracker(fake: SaasFake): ReadableIssueTracker;
  /** The tracker-side state an issue is in for a feedback status. */
  stateOf(status: "open" | "in_progress" | "resolved" | "wont_fix"): string;
}

export const saasProviders: ProviderUnderTest[] = [
  {
    name: "Linear",
    createFake: () => createFakeLinear("team-1"),
    createTracker: (fake) => createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch }),
    stateOf: (status) =>
      ({ open: "unstarted", in_progress: "started", resolved: "completed", wont_fix: "canceled" })[status],
  },
  {
    name: "Jira",
    createFake: () => createFakeJira("WEB"),
    createTracker: (fake) =>
      createJiraTracker({
        siteUrl: "https://acme.atlassian.net",
        projectKey: "WEB",
        email: "bot@acme.com",
        apiToken: TOKEN,
        fetch: fake.fetch,
      }),
    stateOf: (status) => ({ open: "new", in_progress: "indeterminate", resolved: "done", wont_fix: "done" })[status],
  },
  {
    name: "Plane",
    createFake: () => createFakePlane("acme", "proj-1"),
    createTracker: (fake) =>
      createPlaneTracker({ workspaceSlug: "acme", projectId: "proj-1", apiKey: TOKEN, fetch: fake.fetch }),
    stateOf: (status) =>
      ({ open: "unstarted", in_progress: "started", resolved: "completed", wont_fix: "cancelled" })[status],
  },
  {
    name: "ClickUp",
    createFake: () => createFakeClickUp("list-1", "ws-1"),
    createTracker: (fake) =>
      createClickUpTracker({
        listId: "list-1",
        workspaceId: "ws-1",
        token: TOKEN,
        statuses: { wont_fix: "Won't Fix" },
        fetch: fake.fetch,
      }),
    stateOf: (status) =>
      ({ open: "to do", in_progress: "in progress", resolved: "complete", wont_fix: "won't fix" })[status],
  },
];

function setup(provider: ProviderUnderTest, labels: string[] = []) {
  const fake = provider.createFake();
  const tracker = provider.createTracker(fake);
  const logger = { error: vi.fn() };
  const handler = createSitepingHandler({
    store: new MemoryStore(),
    apiKey: API_KEY,
    logger,
    hooks: createIssueTrackerHooks({ tracker, siteUrl: "https://acme.test", labels }),
  });
  let clientIds = 0;
  const send = (body: unknown, method = "POST", auth = false) =>
    new Request(ENDPOINT, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify(body),
    });
  return {
    fake,
    tracker,
    logger,
    async create(): Promise<FeedbackResponse> {
      clientIds += 1;
      const response = await handler.POST(send({ ...payload, clientId: `c-${clientIds}` }));
      expect(response.status).toBe(201);
      return response.json();
    },
    patch: (id: string, status: string) => handler.PATCH(send({ id, projectName: "site", status }, "PATCH", true)),
    remove: (id: string) => handler.DELETE(send({ id, projectName: "site" }, "DELETE", true)),
  };
}

for (const provider of saasProviders) {
  describe(`${provider.name} tracker, through the hooks`, () => {
    it("opens one labelled issue per feedback, its marker kept as the first line", async () => {
      const { fake, tracker, create, logger } = setup(provider, ["needs triage"]);
      const feedback = await create();

      expect(logger.error).not.toHaveBeenCalled();
      expect(fake.issues).toHaveLength(1);
      const [issue] = fake.issues;
      expect(issue?.title).toBe("[SitePing] Checkout fails <b>@​here</b> `rm -rf`");
      const text = fake.descriptionText(issue as NonNullable<typeof issue>);
      // Visible but verbatim: a code span the tracker keeps, read back as the marker.
      expect(text).toContain(`<!-- siteping-feedback {"id":"${feedback.id}","project":"site"} -->`);
      expect(text).toContain("Checkout fails <b>@here</b> `rm -rf`");
      expect(text).toContain("https://acme.test/checkout");

      const read = await tracker.getIssue(fake.issues[0]?.key as string);
      expect(read?.body.split("\n")[0]).toBe(`<!-- siteping-feedback {"id":"${feedback.id}","project":"site"} -->`);
      expect(read?.isOpen).toBe(true);
    });

    it("moves the issue along with the feedback status", async () => {
      const { fake, create, patch, logger } = setup(provider);
      const feedback = await create();
      const issue = () => fake.issues[0] as (typeof fake.issues)[number];

      expect((await patch(feedback.id, "resolved")).status).toBe(200);
      expect(issue().stateKind).toBe(provider.stateOf("resolved"));
      await patch(feedback.id, "wont_fix");
      expect(issue().stateKind).toBe(provider.stateOf("wont_fix"));
      await patch(feedback.id, "in_progress");
      expect(issue().stateKind).toBe(provider.stateOf("in_progress"));
      await patch(feedback.id, "resolved");
      await patch(feedback.id, "open");
      expect(issue().stateKind).toBe(provider.stateOf("open"));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("closes the issue of a deleted feedback with one comment, across retries", async () => {
      const { fake, tracker, create, remove, logger } = setup(provider);
      const feedback = await create();
      const issue = fake.issues[0] as (typeof fake.issues)[number];

      expect((await remove(feedback.id)).status).toBe(200);

      expect(logger.error).not.toHaveBeenCalled();
      expect(issue.stateKind).toBe(provider.stateOf("wont_fix"));
      expect(issue.comments).toHaveLength(1);
      // Markdown on Linear, rendered text on Jira and Plane.
      expect(fake.commentText(issue.comments[0])).toMatch(
        new RegExp(`SitePing feedback \`?${feedback.id}\`? was deleted\\.`),
      );
      // A retried delete finds its comment by the hidden first line.
      const comments = await tracker.listComments({ key: issue.key, url: "" });
      expect(comments[0]?.split("\n")[0]).toBe("<!-- siteping-feedback-deleted -->");
    });

    it("logs a failed creation and keeps the feedback", async () => {
      const { fake, create, logger } = setup(provider);
      fake.failWhen(/./, 500);

      await create();

      expect(logger.error).toHaveBeenCalledWith(
        "[siteping] Hook onCreated failed",
        expect.objectContaining({
          error: expect.objectContaining({ code: "ISSUE_TRACKER_REQUEST_FAILED", status: 500 }),
        }),
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
    });

    it("finds an issue among the newest when its search misses", async () => {
      const { tracker, create } = setup(provider);
      const feedback = await create();

      const listing = await tracker.findSitepingIssues(`"id":"${feedback.id}"`, { maxPages: 1 });

      expect(listing.issues).toHaveLength(1);
      expect(listing.truncated).toBe(false);
    });

    it("refuses a token no header can carry, without echoing it", () => {
      const fake = provider.createFake();
      for (const token of ["", "SECRET\nsecond", "SE CRET"]) {
        const create = () =>
          provider.name === "Linear"
            ? createLinearTracker({ teamId: "t", token, fetch: fake.fetch })
            : provider.name === "Jira"
              ? createJiraTracker({
                  siteUrl: "https://a.atlassian.net",
                  projectKey: "WEB",
                  email: "a@b.c",
                  apiToken: token,
                })
              : provider.name === "Plane"
                ? createPlaneTracker({ workspaceSlug: "a", projectId: "p", apiKey: token })
                : createClickUpTracker({ listId: "l", workspaceId: "w", token });
        expect(create).toThrow(/token must be a non-empty string of visible ASCII/);
        expect(create).not.toThrow(/SECRET/);
      }
    });
  });
}

describe("Linear tracker", () => {
  it("sends a personal API key as is, an OAuth token as Bearer", async () => {
    const fake = createFakeLinear();
    await createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch }).getIssue("missing");
    await createLinearTracker({ teamId: "team-1", token: TOKEN, tokenType: "oauth", fetch: fake.fetch }).getIssue("x");

    expect(fake.requests.map((request) => request.headers.get("authorization"))).toEqual([TOKEN, `Bearer ${TOKEN}`]);
  });

  it("reuses an existing label matched case-insensitively, and creates the missing one once", async () => {
    const fake = createFakeLinear();
    fake.labelCatalog.set("existing", "SitePing");
    const tracker = createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch });

    await tracker.createIssue({ title: "a", body: "b", labels: ["siteping", "bug"] });
    await tracker.createIssue({ title: "c", body: "d", labels: ["siteping", "bug"] });

    expect([...fake.labelCatalog.values()]).toEqual(["SitePing", "bug"]);
    expect(fake.issues.map((issue) => issue.labels)).toEqual([
      ["existing", "label-2"],
      ["existing", "label-2"],
    ]);
  });

  it("raises GraphQL errors answered with a 200 as failed requests", async () => {
    const fake = createFakeLinear();
    const tracker = createLinearTracker({ teamId: "other-team", token: TOKEN, fetch: fake.fetch });

    await expect(tracker.updateIssueStatus({ key: "issue-1", url: "" }, "resolved")).rejects.toMatchObject({
      code: "ISSUE_TRACKER_REQUEST_FAILED",
      status: 200,
    });
  });

  it("uses a configured state name over the first of the type", async () => {
    const fake = createFakeLinear();
    const tracker = createLinearTracker({
      teamId: "team-1",
      token: TOKEN,
      states: { wont_fix: "duplicate" },
      fetch: fake.fetch,
    });
    const reference = await tracker.createIssue({ title: "a", body: "b", labels: ["siteping"] });

    await tracker.updateIssueStatus(reference, "wont_fix");

    const update = fake.requests.find((request) => JSON.stringify(request.body).includes("SitepingIssueUpdate"));
    expect((update!.body as { variables: { input: unknown } }).variables.input).toEqual({ stateId: "st-duplicate" });
  });

  it("answers null for an unknown issue or one without the siteping label", async () => {
    const fake = createFakeLinear();
    const tracker = createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch });
    const unlabelled = await tracker.createIssue({ title: "a", body: "b", labels: [] });

    expect(await tracker.getIssue("missing")).toBeNull();
    expect(await tracker.getIssue(unlabelled.key)).toBeNull();
  });
});

describe("Jira tracker", () => {
  it("authenticates with basic auth and sends an ADF description that quotes visitor text as text", async () => {
    const fake = createFakeJira();
    const tracker = createJiraTracker({
      siteUrl: "https://acme.atlassian.net/",
      projectKey: "WEB",
      email: "bot@acme.com",
      apiToken: TOKEN,
      fetch: fake.fetch,
    });

    const reference = await tracker.createIssue({
      title: "t",
      body: "<!-- siteping-feedback {} -->\n\n## Message\n\n```text\n[x](https://evil.test) <img>\n```\n\n## Page\n\n`https://a.test/`\n\n## Open in the page\n\n<https://a.test/?siteping=1>",
      labels: ["siteping", "needs triage"],
    });

    expect(reference).toEqual({ key: "WEB-1", url: "https://acme.atlassian.net/browse/WEB-1" });
    const request = fake.requests[0];
    expect(request?.headers.get("authorization")).toBe(`Basic ${btoa(`bot@acme.com:${TOKEN}`)}`);
    const { fields } = request!.body as { fields: { description: unknown; labels: string[]; issuetype: unknown } };
    expect(fields.labels).toEqual(["siteping", "needs-triage"]);
    expect(fields.issuetype).toEqual({ name: "Task" });
    expect(fields.description).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<!-- siteping-feedback {} -->", marks: [{ type: "code" }] }],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Message" }] },
        {
          type: "codeBlock",
          attrs: { language: "text" },
          content: [{ type: "text", text: "[x](https://evil.test) <img>" }],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Page" }] },
        { type: "paragraph", content: [{ type: "text", text: "https://a.test/", marks: [{ type: "code" }] }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Open in the page" }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "https://a.test/?siteping=1",
              marks: [{ type: "link", attrs: { href: "https://a.test/?siteping=1" } }],
            },
          ],
        },
      ],
    });
  });

  it("cuts a description past Jira's limit at a section boundary", async () => {
    const fake = createFakeJira();
    const tracker = createJiraTracker({
      siteUrl: "https://a.atlassian.net",
      projectKey: "WEB",
      email: "a@b.c",
      apiToken: TOKEN,
      fetch: fake.fetch,
    });
    const long = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n\n${"x".repeat(1_000)}`).join("\n\n");

    await tracker.createIssue({ title: "t", body: `<!-- m -->\n\n${long}`, labels: [] });

    const text = fake.descriptionText(fake.issues[0] as (typeof fake.issues)[number]);
    expect(text.length).toBeLessThan(32_767);
    expect(text.startsWith("<!-- m -->")).toBe(true);
    expect(text.endsWith("The rest of this feedback is too long for a Jira description.")).toBe(true);
  });

  it("prefers a won't-fix transition for wont_fix, and reads its resolution back", async () => {
    const fake = createFakeJira();
    const tracker = createJiraTracker({
      siteUrl: "https://a.atlassian.net",
      projectKey: "WEB",
      email: "a@b.c",
      apiToken: TOKEN,
      fetch: fake.fetch,
    });
    const reference = await tracker.createIssue({ title: "t", body: "<!-- m -->", labels: ["siteping"] });

    await tracker.updateIssueStatus(reference, "wont_fix");
    expect(fake.issues[0]?.resolution).toBe("Won't Do");
    expect(await tracker.getIssue(reference.key)).toMatchObject({ isOpen: false, closedAs: "wont_fix" });

    await tracker.updateIssueStatus(reference, "resolved");
    expect(fake.issues[0]?.resolution).toBe("Done");
    // "Done" says nothing about why: no close reason.
    expect((await tracker.getIssue(reference.key))?.closedAs).toBeUndefined();
  });

  it("skips a status the issue is already in, and explains one no transition reaches", async () => {
    const fake = createFakeJira();
    // A workflow that offers no transition at all.
    const locked: typeof fetch = async (input, init) =>
      /\/transitions$/.test(new Request(input, init).url) && (init?.method ?? "GET") === "GET"
        ? Response.json({ transitions: [] })
        : fake.fetch(input, init);
    const tracker = createJiraTracker({
      siteUrl: "https://a.atlassian.net",
      projectKey: "WEB",
      email: "a@b.c",
      apiToken: TOKEN,
      fetch: locked,
    });
    const reference = await tracker.createIssue({ title: "t", body: "b", labels: [] });

    await expect(tracker.updateIssueStatus(reference, "open")).resolves.toBeUndefined();
    await expect(tracker.updateIssueStatus(reference, "resolved")).rejects.toThrow(
      /issue WEB-1 has no transition for feedback status "resolved"/,
    );
  });

  it("refuses a project key or email that could not work", () => {
    expect(() =>
      createJiraTracker({ siteUrl: "https://a.atlassian.net", projectKey: "web key", email: "a@b.c", apiToken: TOKEN }),
    ).toThrow(/projectKey/);
    expect(() =>
      createJiraTracker({ siteUrl: "https://a.atlassian.net", projectKey: "WEB", email: "nobody", apiToken: TOKEN }),
    ).toThrow(/email/);
    expect(() =>
      createJiraTracker({ siteUrl: "acme.atlassian.net", projectKey: "WEB", email: "a@b.c", apiToken: TOKEN }),
    ).toThrow(/absolute http/);
  });
});

describe("Plane tracker", () => {
  it("always sends a User-Agent and the X-API-Key header, and HTML that escapes visitor text", async () => {
    const fake = createFakePlane();
    const tracker = createPlaneTracker({
      workspaceSlug: "acme",
      projectId: "proj-1",
      apiKey: TOKEN,
      fetch: fake.fetch,
    });

    const reference = await tracker.createIssue({
      title: "t",
      body: '<!-- siteping-feedback {"id":"f"} -->\n\n## Message\n\n```text\n<script>alert(1)</script>\n```\n\n![Screenshot](<https://cdn.test/s.png>)',
      labels: ["siteping"],
    });

    expect(reference).toEqual({ key: "wi-1", url: "https://app.plane.so/acme/projects/proj-1/issues/wi-1" });
    for (const request of fake.requests) {
      expect(request.headers.get("user-agent")).toBe("siteping-integration-issues");
      expect(request.headers.get("x-api-key")).toBe(TOKEN);
    }
    const created = fake.requests.find((request) => request.method === "POST" && request.path.endsWith("/work-items/"));
    expect((created!.body as { description_html: string }).description_html).toBe(
      "<p><code>&lt;!-- siteping-feedback {&quot;id&quot;:&quot;f&quot;} --&gt;</code></p><h2>Message</h2>" +
        "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>" +
        '<p><a href="https://cdn.test/s.png" rel="noopener noreferrer nofollow">Screenshot</a></p>',
    );
  });

  it("links to a self-hosted instance's own origin", async () => {
    const fake = createFakePlane();
    const tracker = createPlaneTracker({
      workspaceSlug: "acme",
      projectId: "proj-1",
      apiKey: TOKEN,
      apiBaseUrl: "https://plane.acme.test",
      fetch: fake.fetch,
    });

    expect((await tracker.createIssue({ title: "t", body: "b", labels: [] })).url).toBe(
      "https://plane.acme.test/acme/projects/proj-1/issues/wi-1",
    );
  });

  it("is refused by Plane without a User-Agent, which the tracker never omits", async () => {
    const fake = createFakePlane();
    const bare: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("user-agent");
      return fake.fetch(input, { ...init, headers });
    };
    const tracker = createPlaneTracker({ workspaceSlug: "acme", projectId: "proj-1", apiKey: TOKEN, fetch: bare });

    await expect(tracker.listComments({ key: "wi-1", url: "" })).rejects.toMatchObject({ status: 403 });
  });

  it("answers null for an unknown work item", async () => {
    const fake = createFakePlane();
    const tracker = createPlaneTracker({
      workspaceSlug: "acme",
      projectId: "proj-1",
      apiKey: TOKEN,
      fetch: fake.fetch,
    });

    expect(await tracker.getIssue("nope")).toBeNull();
  });
});

describe("ClickUp tracker", () => {
  const clickUp = (fake: SaasFake, options: Partial<Parameters<typeof createClickUpTracker>[0]> = {}) =>
    createClickUpTracker({ listId: "list-1", workspaceId: "ws-1", token: TOKEN, fetch: fake.fetch, ...options });
  const marker = '<!-- siteping-feedback {"id":"f","project":"site"} -->';

  it("sends a personal token as is, an OAuth token as Bearer, to the v2 API", async () => {
    const fake = createFakeClickUp();
    await clickUp(fake).getIssue("cu1");
    await clickUp(fake, { tokenType: "oauth" }).getIssue("cu1");

    expect(fake.requests.map((request) => request.headers.get("authorization"))).toEqual([TOKEN, `Bearer ${TOKEN}`]);
    expect(fake.requests[0]?.path).toBe("/api/v2/task/cu1?include_markdown_description=true");
  });

  it("creates a tagged task in the list with a Markdown description, its marker as a code span", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);

    const reference = await tracker.createIssue({
      title: "[SitePing] t",
      body: `${marker}\n\n## Message\n\n\`\`\`text\n@everyone <script>\n\`\`\``,
      labels: ["siteping", "Needs Triage"],
    });

    expect(reference).toEqual({ key: "cu1", url: "https://app.clickup.com/t/cu1" });
    const created = fake.requests.find((request) => request.method === "POST");
    expect(created?.path).toBe("/api/v2/list/list-1/task");
    expect(created?.body).toEqual({
      name: "[SitePing] t",
      markdown_content: `\`${marker}\`\n\n## Message\n\n\`\`\`text\n@everyone <script>\n\`\`\``,
      description: `\`${marker}\`\n\n## Message\n\n\`\`\`text\n@everyone <script>\n\`\`\``,
      tags: ["siteping", "Needs Triage"],
    });
    const read = await tracker.getIssue("cu1");
    expect(read).toMatchObject({ reference, isOpen: true });
    expect(read?.body.split("\n")[0]).toBe(marker);
  });

  it("reads the marker from the plain-text description when the Markdown one lacks it", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);
    await tracker.createIssue({ title: "t", body: `${marker}\n\nBody`, labels: ["siteping"] });
    const issue = fake.issues[0] as SaasFake["issues"][number];
    const plain = fake.fetch;
    // A ClickUp that answers no `markdown_description`.
    const withoutMarkdown: typeof fetch = async (input, init) => {
      const response = await plain(input, init);
      const json = await response.json();
      delete json.markdown_description;
      return Response.json(json, { status: response.status });
    };

    const read = await clickUp({ ...fake, fetch: withoutMarkdown }).getIssue(issue.key);

    expect(read?.body.split("\n")[0]).toBe(marker);
  });

  it("raises when ClickUp dropped the siteping tag", async () => {
    const fake = createFakeClickUp();
    const dropTags: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      const json = await response.json();
      return Response.json({ ...json, tags: [] });
    };

    await expect(
      clickUp({ ...fake, fetch: dropTags }).createIssue({ title: "t", body: "b", labels: ["siteping"] }),
    ).rejects.toMatchObject({ code: "UNLABELLED_ISSUE" });
  });

  it("moves tasks by the list's status types without names, and by the configured names otherwise", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);
    const { key } = await tracker.createIssue({ title: "t", body: "b", labels: [] });
    const statusOf = () => fake.issues[0]?.stateKind;

    await tracker.updateIssueStatus({ key, url: "" }, "in_progress");
    expect(statusOf()).toBe("in progress");
    await tracker.updateIssueStatus({ key, url: "" }, "resolved");
    expect(statusOf()).toBe("complete");
    await tracker.updateIssueStatus({ key, url: "" }, "wont_fix");
    expect(statusOf()).toBe("complete");
    await tracker.updateIssueStatus({ key, url: "" }, "open");
    expect(statusOf()).toBe("to do");

    const named = clickUp(fake, { statuses: { wont_fix: "WON'T FIX" } });
    await named.updateIssueStatus({ key, url: "" }, "wont_fix");
    expect(statusOf()).toBe("won't fix");
    expect(fake.requests.at(-1)?.body).toEqual({ status: "won't fix" });
    // The list's statuses are read once per tracker.
    expect(fake.requests.filter((request) => request.path === "/api/v2/list/list-1")).toHaveLength(2);
  });

  it("tells won't-fix tasks apart only with a named won't-fix status", async () => {
    const fake = createFakeClickUp();
    await clickUp(fake).createIssue({ title: "t", body: marker, labels: ["siteping"] });
    const issue = fake.issues[0] as SaasFake["issues"][number];

    issue.stateKind = "won't fix";
    expect(await clickUp(fake).getIssue(issue.key)).toMatchObject({ isOpen: false });
    expect((await clickUp(fake).getIssue(issue.key))?.closedAs).toBeUndefined();
    const named = clickUp(fake, { statuses: { wont_fix: "won't fix" } });
    expect((await named.getIssue(issue.key))?.closedAs).toBe("wont_fix");
    issue.stateKind = "complete";
    expect((await named.getIssue(issue.key))?.closedAs).toBe("resolved");
  });

  it("comments without notifying, and lists every comment across pages of 25", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);
    const { key } = await tracker.createIssue({ title: "t", body: "b", labels: [] });
    for (let index = 0; index < 60; index++) await tracker.addComment({ key, url: "" }, `comment ${index}`);

    const comments = await tracker.listComments({ key, url: "" });

    expect(fake.requests.find((request) => request.path.endsWith("/comment"))?.body).toEqual({
      comment_text: "comment 0",
      notify_all: false,
    });
    expect(comments).toHaveLength(60);
    expect(comments[0]).toBe("comment 59");
    expect(comments.at(-1)).toBe("comment 0");
  });

  it("lists the list's tagged tasks, closed ones included, and says when pages are left", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake, { maxListedPages: 1 });
    for (let index = 0; index < 101; index++) {
      await tracker.createIssue({ title: "t", body: marker, labels: ["siteping"] });
    }
    (fake.issues[100] as SaasFake["issues"][number]).stateKind = "complete";

    const listing = await tracker.findSitepingIssues('"id":"f"');

    expect(listing.issues).toHaveLength(100);
    expect(listing.issues[0]).toMatchObject({ reference: { key: "cu101" }, isOpen: false });
    expect(listing.truncated).toBe(true);
    expect(fake.requests.at(-1)?.path).toContain("include_closed=true");
    expect(fake.requests.at(-1)?.path).toContain("tags%5B%5D=siteping");
  });

  it("never reads a task of another list or workspace as a SitePing task, tag and marker notwithstanding", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);
    await tracker.createIssue({ title: "t", body: marker, labels: ["siteping"] });
    await tracker.createIssue({ title: "t", body: marker, labels: ["siteping"] });
    const [otherList, otherWorkspace] = fake.issues as [SaasFake["issues"][number], SaasFake["issues"][number]];
    otherList.scope = "list-2";
    otherWorkspace.workspace = "ws-2";
    // A list endpoint that answers tasks of other lists too (tasks in multiple lists).
    const leaky: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/api/v2/list/list-1/task" || init?.method !== "GET") return fake.fetch(input, init);
      const tasks = await Promise.all(
        fake.issues.map(async (issue) =>
          (
            await fake.fetch(`https://api.clickup.com/api/v2/task/${issue.key}?include_markdown_description=true`, {
              headers: { Authorization: TOKEN },
            })
          ).json(),
        ),
      );
      return Response.json({ tasks, last_page: true });
    };

    expect(await tracker.getIssue(otherList.key)).toBeNull();
    expect(await tracker.getIssue(otherWorkspace.key)).toBeNull();
    expect((await clickUp({ ...fake, fetch: leaky }).findSitepingIssues('"id":"f"')).issues).toEqual([]);
  });

  it("answers null for an unknown task, an untagged one, and a key that is no task id without asking ClickUp", async () => {
    const fake = createFakeClickUp();
    const tracker = clickUp(fake);
    await tracker.createIssue({ title: "t", body: marker, labels: [] });

    expect(await tracker.getIssue("nope")).toBeNull();
    expect(await tracker.getIssue("cu1")).toBeNull();
    const before = fake.requests.length;
    expect(await tracker.getIssue("../list/list-1")).toBeNull();
    expect(fake.requests).toHaveLength(before);
  });

  it("raises other failures as failed requests", async () => {
    const fake = createFakeClickUp();
    fake.failWhen(/GET \/api\/v2\/task/, 401);

    await expect(clickUp(fake).getIssue("cu1")).rejects.toMatchObject({
      code: "ISSUE_TRACKER_REQUEST_FAILED",
      status: 401,
    });
  });

  it("refuses a list or workspace id that could not work", () => {
    expect(() => createClickUpTracker({ listId: "list/../x", workspaceId: "w", token: TOKEN })).toThrow(/listId/);
    expect(() => createClickUpTracker({ listId: "l", workspaceId: "", token: TOKEN })).toThrow(/workspaceId/);
    expect(() =>
      createClickUpTracker({ listId: "l", workspaceId: "w", token: TOKEN, apiBaseUrl: "api.clickup.com" }),
    ).toThrow(/absolute http/);
  });
});
