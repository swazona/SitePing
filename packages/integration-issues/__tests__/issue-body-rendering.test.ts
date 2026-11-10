import type { FeedbackRecord } from "@siteping/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { createIssueTrackerHooks, type IssueTracker } from "../src/index.js";
import { createClickUpTracker } from "../src/providers/clickup.js";
import { createGitHubTracker } from "../src/providers/github.js";
import { createGitLabTracker } from "../src/providers/gitlab.js";
import { createJiraTracker } from "../src/providers/jira.js";
import { createLinearTracker } from "../src/providers/linear.js";
import { createPlaneTracker } from "../src/providers/plane.js";
import { createFakeClickUp, createFakeJira, createFakeLinear, createFakePlane } from "./fake-saas-trackers.js";
import { createFakeGitHub, createFakeGitLab } from "./fake-trackers.js";

/*
 * What each tracker receives for a feedback whose every new field (flow
 * title and id, component names, recording URL) is hostile: read in the
 * tracker's own format, nothing outside code may mention, reference, link,
 * embed or open markup — but the deep link and the recording, both built
 * from parsed URLs.
 */

const TOKEN = "tracker-secret-token";
const SITE = "https://acme.test";
const RECORDING = "https://media.acme.test/rec/a.webm";
const DEEP_LINK = `${SITE}/checkout?siteping=fb-1`;

const payloads = [
  "@octocat",
  "@acme/maintainers",
  "#12",
  "[~accountid:5b10a2844c20165700ede21g]",
  "<!-- the rest is hidden",
  "![pixel](https://tracker.test/pixel.png)",
  "[reset](javascript:alert(1))",
  "<img src=x onerror=alert(1)>",
  "<a href=https://tracker.test>x</a>",
  "# Heading",
  "```",
  "`` ` ``",
];
const leaks = [
  "octocat",
  "maintainers",
  "#12",
  "accountid",
  "<!--",
  "tracker.test",
  "javascript:",
  "<img",
  "<a ",
  "Heading",
];
const hostile = payloads.join("\n");

const feedback: FeedbackRecord = {
  id: "fb-1",
  type: "bug",
  message: "Broken",
  status: "open",
  projectName: "site",
  url: "/checkout",
  urlPattern: null,
  authorName: "Alice",
  authorEmail: "alice@example.com",
  viewport: "1280x720",
  userAgent: "Mozilla/5.0",
  clientId: "client-1",
  resolvedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  annotations: [],
  screenshotUrl: null,
  screenshotRegion: null,
  flowId: hostile,
  flowStep: 3,
  flowTitle: hostile,
  diagnostics: {
    console: [],
    network: [],
    components: ["App", hostile, "PricingCard"],
    recording: { url: RECORDING, mimeType: "video/webm", durationMs: 4200, bytes: 10 },
  },
};

interface Rendered {
  /** Text a reader sees outside code, where trackers resolve mentions and references. */
  live: string;
  /** Text inside code: where the hostile values must sit. */
  code: string;
  links: string[];
  /** Markup the description holds, by element or node name. */
  markup: string[];
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function fromMarkdownBody(body: string): Rendered {
  const rendered: Rendered = { live: "", code: "", links: [], markup: [] };
  const walk = (node: MarkdownNode): void => {
    rendered.markup.push(node.type);
    if (node.type === "code" || node.type === "inlineCode") {
      rendered.code += `${node.value}\n`;
      return;
    }
    if ((node.type === "link" || node.type === "image") && node.url) rendered.links.push(node.url);
    if (node.value !== undefined) rendered.live += `${node.value}\n`;
    node.children?.forEach(walk);
  };
  walk(fromMarkdown(body) as MarkdownNode);
  return rendered;
}

interface AdfNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: { href?: string } }>;
  content?: AdfNode[];
}

function fromAdf(document: AdfNode): Rendered {
  const rendered: Rendered = { live: "", code: "", links: [], markup: [] };
  const walk = (node: AdfNode, inCode: boolean): void => {
    rendered.markup.push(node.type);
    const code = inCode || node.type === "codeBlock" || (node.marks ?? []).some((mark) => mark.type === "code");
    for (const mark of node.marks ?? []) if (mark.type === "link") rendered.links.push(mark.attrs?.href ?? "");
    if (node.text !== undefined) {
      if (code) rendered.code += `${node.text}\n`;
      else rendered.live += `${node.text}\n`;
    }
    for (const child of node.content ?? []) walk(child, code);
  };
  walk(document, false);
  return rendered;
}

function fromHtml(html: string): Rendered {
  const rendered: Rendered = { live: "", code: "", links: [], markup: [] };
  const tags = html.match(/<\/?[a-z0-9]+[^>]*>/gi) ?? [];
  for (const tag of tags) {
    rendered.markup.push(tag.replace(/^<\/?([a-z0-9]+).*$/is, "$1").toLowerCase());
    const href = tag.match(/^<a href="([^"]*)"/)?.[1];
    if (href) rendered.links.push(href.replaceAll("&amp;", "&"));
  }
  const decode = (text: string) =>
    text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
  rendered.code = decode((html.match(/<code>[\s\S]*?<\/code>/g) ?? []).join("\n").replace(/<[^>]+>/g, ""));
  rendered.live = decode(html.replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<[^>]+>/g, "\n"));
  return rendered;
}

const withoutMarkerLine = (body: string): string => body.split("\n").slice(1).join("\n");

interface TrackerCase {
  name: string;
  /** Markup the format may hold. */
  allowedMarkup: readonly string[];
  open(): { tracker: IssueTracker; description(): Rendered };
}

// Lists: the empty diagnostics placeholder.
const MARKDOWN_NODES = [
  "root",
  "heading",
  "paragraph",
  "text",
  "code",
  "inlineCode",
  "link",
  "image",
  "list",
  "listItem",
];

const trackers: TrackerCase[] = [
  {
    name: "GitHub",
    allowedMarkup: MARKDOWN_NODES,
    open() {
      const fake = createFakeGitHub("acme/site");
      return {
        tracker: createGitHubTracker({ repository: "acme/site", token: TOKEN, fetch: fake.fetch }),
        // The hidden marker line is the hooks', not the visitor's: an HTML comment there is the point.
        description: () => fromMarkdownBody(withoutMarkerLine(fake.issues[0]?.body ?? "")),
      };
    },
  },
  {
    name: "GitLab",
    allowedMarkup: MARKDOWN_NODES,
    open() {
      const fake = createFakeGitLab("acme/site");
      return {
        tracker: createGitLabTracker({ project: "acme/site", token: TOKEN, fetch: fake.fetch }),
        // The hidden marker line is the hooks', not the visitor's: an HTML comment there is the point.
        description: () => fromMarkdownBody(withoutMarkerLine(fake.issues[0]?.body ?? "")),
      };
    },
  },
  {
    name: "Linear",
    allowedMarkup: MARKDOWN_NODES,
    open() {
      const fake = createFakeLinear();
      return {
        tracker: createLinearTracker({ teamId: "team-1", token: TOKEN, fetch: fake.fetch }),
        description: () => fromMarkdownBody(String(fake.issues[0]?.description)),
      };
    },
  },
  {
    name: "ClickUp",
    allowedMarkup: MARKDOWN_NODES,
    open() {
      const fake = createFakeClickUp();
      return {
        tracker: createClickUpTracker({ listId: "list-1", workspaceId: "ws-1", token: TOKEN, fetch: fake.fetch }),
        description: () => fromMarkdownBody(String(fake.issues[0]?.description)),
      };
    },
  },
  {
    name: "Jira",
    allowedMarkup: ["doc", "heading", "paragraph", "text", "codeBlock", "bulletList", "listItem", "hardBreak"],
    open() {
      const fake = createFakeJira();
      return {
        tracker: createJiraTracker({
          siteUrl: "https://acme.atlassian.net",
          projectKey: "WEB",
          email: "bot@acme.test",
          apiToken: TOKEN,
          fetch: fake.fetch,
        }),
        description: () => fromAdf(fake.issues[0]?.description as AdfNode),
      };
    },
  },
  {
    name: "Plane",
    allowedMarkup: ["p", "h2", "pre", "code", "a", "em", "ul", "li", "br"],
    open() {
      const fake = createFakePlane();
      return {
        tracker: createPlaneTracker({ workspaceSlug: "acme", projectId: "proj-1", apiKey: TOKEN, fetch: fake.fetch }),
        description: () => fromHtml(String(fake.issues[0]?.description)),
      };
    },
  },
];

describe("issue bodies with a flow, a component path and a recording", () => {
  for (const { name, allowedMarkup, open } of trackers) {
    it(`${name}: quote hostile values as code, linking only the deep link and the recording`, async () => {
      const { tracker, description } = open();

      await createIssueTrackerHooks({ tracker, siteUrl: SITE }).onCreated(feedback);
      const rendered = description();

      for (const leak of leaks) expect(rendered.live).not.toContain(leak);
      expect(new Set(rendered.links)).toEqual(new Set([DEEP_LINK, RECORDING]));
      for (const markup of rendered.markup) expect(allowedMarkup).toContain(markup);
      expect(rendered.live).toContain("Flow");
      expect(rendered.live).toContain("Step 3 of");
      expect(rendered.live).toContain("Component path");
      expect(rendered.live).toContain("Screen recording");
      expect(rendered.code).toContain("PricingCard");
      // Each hostile line reached the tracker, inside code.
      expect(rendered.code).toContain("@octocat");
      expect(rendered.code).toContain("<img src=x onerror=alert(1)>");
    });
  }
});
