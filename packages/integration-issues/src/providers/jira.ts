import type { FeedbackStatus } from "@siteping/core";
import { TRACKER_MAX_LISTED_PAGES } from "../constants/http.js";
import { ISSUE_SECTION_SEPARATOR, SITEPING_ISSUE_LABEL } from "../constants/issue-format.js";
import {
  JIRA_API_PATH,
  JIRA_DEFAULT_ISSUE_TYPE,
  JIRA_DESCRIPTION_MAX_LENGTH,
  JIRA_PAGE_SIZE,
  JIRA_SIGNATURE_HEADER,
  JIRA_STATUS_CATEGORY,
  JIRA_TRUNCATED_NOTE,
  JIRA_WONT_FIX_PATTERN,
} from "../constants/jira.js";
import { createJsonHttpClient, isIssueTrackerRequestError } from "../core/http-client.js";
import type { ReadableIssueTracker, TrackedIssue } from "../core/issue-tracker.js";
import { adfToText, markdownToAdf, withHiddenMarker, withVisibleMarker } from "../core/rich-text.js";
import { checkApiBaseUrl, checkPositiveInteger, checkTimeout, checkToken } from "../core/tracker-options.js";
import {
  asRecord,
  createWebhookHandler,
  type IssueWebhookOptions,
  timingSafeEqual,
  verifyHexSignature,
} from "../core/webhook.js";

export interface JiraTrackerOptions {
  /** Your Jira Cloud site, e.g. `https://acme.atlassian.net`. */
  siteUrl: string;
  /** Key of the project issues are created in, e.g. `WEB`. */
  projectKey: string;
  /** Email of the Atlassian account the API token belongs to. */
  email: string;
  /** An Atlassian API token of that account (basic auth). */
  apiToken: string;
  /** Issue type of new issues. Defaults to `Task`. */
  issueType?: string | undefined;
  /**
   * Transition names to use instead of the first transition into the
   * matching status category: `resolved` and `wont_fix` → Done, `open` → To
   * Do, `in_progress` → In Progress. Matched case-insensitively.
   */
  transitions?: Partial<Record<FeedbackStatus, string>> | undefined;
  /**
   * Resolutions read as "won't fix" when an issue is done, and transition
   * names preferred for `wont_fix`. Defaults to Jira's own ("Won't Do",
   * "Won't Fix", "Duplicate", "Cannot Reproduce", "Declined"…).
   */
  wontFixPattern?: RegExp | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Most pages of 100 issues listed — see the GitHub tracker's option of the same name. Defaults to 10. */
  maxListedPages?: number | undefined;
}

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string };
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    description?: unknown;
    status?: JiraStatus;
    resolution?: { name?: string } | null;
    labels?: string[];
    project?: { key?: string };
  };
}

interface JiraTransition {
  id: string;
  name: string;
  to?: JiraStatus;
}

const ISSUE_FIELDS = ["description", "status", "resolution", "labels", "project"];

/** The status category each feedback status moves a Jira issue into, best first. */
const CATEGORIES: Record<FeedbackStatus, readonly string[]> = {
  resolved: [JIRA_STATUS_CATEGORY.done],
  wont_fix: [JIRA_STATUS_CATEGORY.done],
  open: [JIRA_STATUS_CATEGORY.toDo, JIRA_STATUS_CATEGORY.inProgress],
  in_progress: [JIRA_STATUS_CATEGORY.inProgress, JIRA_STATUS_CATEGORY.toDo],
};

/** Jira labels cannot hold spaces. */
const toJiraLabel = (label: string): string => label.trim().replace(/\s+/g, "-");

/** Base64 of UTF-8 text, on any runtime. */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The Markdown cut at a section boundary to fit a Jira description, with a note when cut. */
function fitDescription(markdown: string): string {
  if (markdown.length <= JIRA_DESCRIPTION_MAX_LENGTH) return markdown;
  const budget = JIRA_DESCRIPTION_MAX_LENGTH - JIRA_TRUNCATED_NOTE.length - ISSUE_SECTION_SEPARATOR.length;
  const cut = markdown.lastIndexOf(ISSUE_SECTION_SEPARATOR, budget);
  return `${markdown.slice(0, cut > 0 ? cut : budget)}${ISSUE_SECTION_SEPARATOR}${JIRA_TRUNCATED_NOTE}`;
}

/** JQL string literal: Jira escapes `"` and `\` with a backslash. */
const jqlString = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;

/**
 * `IssueTracker` on Jira Cloud (REST API v3). Descriptions and comments go
 * as Atlassian Document Format; the linking marker is the description's
 * first paragraph, in code, since Jira has no hidden text.
 */
export function createJiraTracker({
  siteUrl,
  projectKey,
  email,
  apiToken,
  issueType = JIRA_DEFAULT_ISSUE_TYPE,
  transitions: transitionNames = {},
  wontFixPattern = JIRA_WONT_FIX_PATTERN,
  fetch,
  timeoutMs,
  maxListedPages = TRACKER_MAX_LISTED_PAGES,
}: JiraTrackerOptions): ReadableIssueTracker {
  if (typeof projectKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(projectKey)) {
    throw new Error('[siteping] createJiraTracker: projectKey must be a Jira project key like "WEB"');
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) {
    throw new Error("[siteping] createJiraTracker: email must be the API token's account email");
  }
  const credential = checkToken("createJiraTracker", apiToken);
  checkApiBaseUrl("createJiraTracker", siteUrl);
  checkTimeout("createJiraTracker", timeoutMs);
  checkPositiveInteger("createJiraTracker", "maxListedPages", maxListedPages);
  const site = siteUrl.replace(/\/+$/, "");
  const request = createJsonHttpClient({
    tracker: "Jira",
    baseUrl: `${site}${JIRA_API_PATH}`,
    headers: { Accept: "application/json", Authorization: `Basic ${base64(`${email.trim()}:${credential}`)}` },
    ...(fetch ? { fetch } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const browseUrl = (key: string) => `${site}/browse/${encodeURIComponent(key)}`;

  /** Whether the issue is in `projectKey`: another project's issue is not ours, whatever label and marker it carries. */
  const inProject = (issue: JiraIssue): boolean =>
    issue.fields.project?.key?.toUpperCase() === projectKey.toUpperCase();

  const toTrackedIssue = (issue: JiraIssue): TrackedIssue => {
    const done = issue.fields.status?.statusCategory?.key === JIRA_STATUS_CATEGORY.done;
    const resolution = issue.fields.resolution?.name;
    return {
      reference: { key: issue.key, url: browseUrl(issue.key) },
      body: withHiddenMarker(adfToText(issue.fields.description)),
      isOpen: !done,
      // A done issue's reason is only known when its resolution says "won't fix".
      ...(done && resolution && wontFixPattern.test(resolution) ? { closedAs: "wont_fix" as const } : {}),
    };
  };

  /** Pages of the project's SitePing issues matching `extraJql`, newest first. */
  const search = async (extraJql: string, pages: number) => {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 1; page <= pages; page++) {
      const answer = await request<{ issues: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }>({
        method: "POST",
        path: "/search/jql",
        body: {
          jql: `project = ${jqlString(projectKey)} AND labels = ${jqlString(SITEPING_ISSUE_LABEL)}${extraJql} ORDER BY created DESC`,
          fields: ISSUE_FIELDS,
          maxResults: JIRA_PAGE_SIZE,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      // The JQL scopes to the project already; checked again on what comes back.
      issues.push(...answer.issues.filter(inProject));
      if (answer.isLast !== false && !answer.nextPageToken) return { issues, truncated: false };
      nextPageToken = answer.nextPageToken ?? undefined;
      if (!nextPageToken) return { issues, truncated: false };
    }
    return { issues, truncated: true };
  };

  const issuePath = (key: string) => `/issue/${encodeURIComponent(key)}`;

  return {
    name: "Jira",

    async createIssue({ title, body, labels }) {
      const issue = await request<{ id: string; key: string }>({
        method: "POST",
        path: "/issue",
        body: {
          fields: {
            project: { key: projectKey },
            issuetype: { name: issueType },
            summary: title,
            description: markdownToAdf(fitDescription(withVisibleMarker(body))),
            labels: labels.map(toJiraLabel),
          },
        },
      });
      return { key: issue.key, url: browseUrl(issue.key) };
    },

    async updateIssueStatus(reference, status) {
      const { transitions } = await request<{ transitions: JiraTransition[] }>({
        method: "GET",
        path: `${issuePath(reference.key)}/transitions`,
      });
      const named = transitionNames[status]?.toLowerCase();
      const into = (category: string) =>
        transitions.filter((transition) => transition.to?.statusCategory?.key === category);
      const candidates = CATEGORIES[status].flatMap(into);
      const transition =
        (named ? transitions.find((candidate) => candidate.name.toLowerCase() === named) : undefined) ??
        (status === "wont_fix" ? candidates.find((candidate) => wontFixPattern.test(candidate.name)) : undefined) ??
        candidates[0];
      if (transition) {
        await request({
          method: "POST",
          path: `${issuePath(reference.key)}/transitions`,
          body: { transition: { id: transition.id } },
        });
        return;
      }
      // No way in: fine when the issue already is in that category (a done issue resolved again).
      const { fields } = await request<JiraIssue>({
        method: "GET",
        path: issuePath(reference.key),
        query: { fields: "status" },
      });
      const current = fields.status?.statusCategory?.key;
      if (current && CATEGORIES[status].includes(current)) return;
      throw new Error(
        `[siteping] Jira: issue ${reference.key} has no transition for feedback status "${status}". ` +
          "Name one with the `transitions` option.",
      );
    },

    async addComment(reference, body) {
      await request({
        method: "POST",
        path: `${issuePath(reference.key)}/comment`,
        body: { body: markdownToAdf(withVisibleMarker(body)) },
      });
    },

    async listComments(reference) {
      const bodies: string[] = [];
      for (let page = 0; page < maxListedPages; page++) {
        const answer = await request<{ comments: Array<{ body?: unknown }>; total: number }>({
          method: "GET",
          path: `${issuePath(reference.key)}/comment`,
          query: { startAt: String(page * JIRA_PAGE_SIZE), maxResults: String(JIRA_PAGE_SIZE) },
        });
        bodies.push(...answer.comments.map((comment) => withHiddenMarker(adfToText(comment.body))));
        if (answer.comments.length < JIRA_PAGE_SIZE || bodies.length >= answer.total) break;
      }
      return bodies;
    },

    async searchSitepingIssues(feedbackId) {
      // `text ~` matches words of the description, among other fields: the id as one phrase.
      const { issues, truncated } = await search(
        ` AND text ~ ${jqlString(`"${feedbackId.replace(/["\\]/g, "")}"`)}`,
        1,
      );
      return { issues: issues.map(toTrackedIssue), truncated };
    },

    async findSitepingIssues(marker, { maxPages = maxListedPages } = {}) {
      const { issues, truncated } = await search("", Math.min(maxPages, maxListedPages));
      return { issues: issues.map(toTrackedIssue).filter((issue) => issue.body.includes(marker)), truncated };
    },

    async getIssue(key) {
      let issue: JiraIssue;
      try {
        issue = await request<JiraIssue>({
          method: "GET",
          path: issuePath(key),
          query: { fields: ISSUE_FIELDS.join(",") },
        });
      } catch (error) {
        if (isIssueTrackerRequestError(error) && error.status === 404) return null;
        throw error;
      }
      const labelled = (issue.fields.labels ?? []).some((label) => label.toLowerCase() === SITEPING_ISSUE_LABEL);
      return labelled && inProject(issue) ? toTrackedIssue(issue) : null;
    },
  };
}

export interface JiraWebhookOptions extends IssueWebhookOptions {
  /** The tracker the issues were opened with: each delivery's issue is read back through it. */
  tracker: ReadableIssueTracker;
  /**
   * Also accept deliveries carrying the secret verbatim in this header,
   * without a signature — for Jira Automation's "Send web request", which
   * cannot sign but can add headers. Off by default: anyone who reads the
   * header once (a proxy log) can then forge deliveries, which a signature
   * prevents.
   */
  secretHeader?: string | undefined;
}

/**
 * Two-way sync from Jira Cloud: a Fetch API handler for an admin webhook
 * (with a secret) on `jira:issue_updated`. It checks the `X-Hub-Signature`
 * HMAC (`sha256=…`), and when a delivery changed an issue's status or
 * resolution, reads the issue through `tracker` and moves its feedback to
 * `resolved` (Done), `wont_fix` (Done with a "won't fix" resolution) or back
 * to `open`.
 */
export function createJiraWebhookHandler({
  tracker,
  secretHeader,
  ...options
}: JiraWebhookOptions): (request: Request) => Promise<Response> {
  const { secret } = options;
  return createWebhookHandler(
    {
      tracker: "Jira",
      factory: "createJiraWebhookHandler",
      async verify(request, body) {
        const signature = request.headers.get(JIRA_SIGNATURE_HEADER);
        if (signature) {
          const [method, digest = null] = signature.split("=", 2);
          return method?.toLowerCase() === "sha256" && verifyHexSignature(secret, body, digest);
        }
        const shared = secretHeader ? request.headers.get(secretHeader) : null;
        return shared !== null && timingSafeEqual(shared, secret);
      },
      async issueOf(payload) {
        const { webhookEvent, issue, changelog } = asRecord(payload);
        if (webhookEvent !== "jira:issue_updated") return null;
        const items = asRecord(changelog).items;
        const changed =
          Array.isArray(items) &&
          items.some((item) => ["status", "resolution"].includes(String(asRecord(item).field).toLowerCase()));
        const key = asRecord(issue).key;
        return changed && typeof key === "string" ? tracker.getIssue(key) : null;
      },
    },
    options,
  );
}

export type { IssueReference, IssueTracker, ReadableIssueTracker } from "../core/issue-tracker.js";
export type { IssueStatusSync, IssueWebhookOptions, IssueWebhookStore } from "../core/webhook.js";
