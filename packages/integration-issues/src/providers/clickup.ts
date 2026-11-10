import type { FeedbackStatus } from "@siteping/core";
import {
  CLICKUP_API_BASE_URL,
  CLICKUP_API_PATH,
  CLICKUP_COMMENT_PAGE_SIZE,
  CLICKUP_SIGNATURE_HEADER,
  CLICKUP_STATUS_EVENT,
  CLICKUP_STATUS_TYPE,
  CLICKUP_TASK_PAGE_SIZE,
} from "../constants/clickup.js";
import { TRACKER_MAX_LISTED_PAGES } from "../constants/http.js";
import { SITEPING_ISSUE_LABEL } from "../constants/issue-format.js";
import { createJsonHttpClient, isIssueTrackerRequestError, UnlabelledIssueError } from "../core/http-client.js";
import { parseIssueMarker } from "../core/issue-format.js";
import type { ReadableIssueTracker, TrackedIssue } from "../core/issue-tracker.js";
import { withHiddenMarker, withVisibleMarker } from "../core/rich-text.js";
import { checkApiBaseUrl, checkPositiveInteger, checkTimeout, checkToken } from "../core/tracker-options.js";
import { asRecord, createWebhookHandler, type IssueWebhookOptions, verifyHexSignature } from "../core/webhook.js";

export interface ClickUpTrackerOptions {
  /** Id of the list tasks are created in, as in `https://app.clickup.com/<workspace>/v/li/<list>`. */
  listId: string;
  /**
   * Id of the workspace (`team_id` in the API) the list belongs to, as in
   * `https://app.clickup.com/<workspace>/`. A task of any other workspace is
   * not a SitePing task, whatever it carries.
   */
  workspaceId: string;
  /** A personal API token (`pk_…`), or an OAuth access token with `tokenType: "oauth"`. */
  token: string;
  /** `personal` (default) sends the token as is, `oauth` as `Bearer`. */
  tokenType?: "personal" | "oauth" | undefined;
  /**
   * Status names to use instead of the list's first status of the matching
   * type: `resolved` → the `closed` status (or a `done` one), `open` → the
   * `open` status, `in_progress` → the first `custom` one. ClickUp has no
   * close reason: name a `wont_fix` status (a `done` or `closed` one) to
   * tell won't-fix tasks apart, both ways. Matched case-insensitively.
   */
  statuses?: Partial<Record<FeedbackStatus, string>> | undefined;
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Most pages of 100 tasks listed — see the GitHub tracker's option of the same name. Defaults to 10. */
  maxListedPages?: number | undefined;
}

interface ClickUpStatus {
  status: string;
  type: string;
  orderindex?: number | string;
}

interface ClickUpTask {
  id: string;
  url?: string;
  description?: string | null;
  text_content?: string | null;
  markdown_description?: string | null;
  status?: { status?: string; type?: string } | null;
  tags?: Array<{ name?: string }>;
  list?: { id?: string | number } | null;
  team_id?: string | number | null;
}

/** The status types each feedback status moves a task to, best first. */
const STATUS_TYPES: Record<FeedbackStatus, readonly string[]> = {
  resolved: [CLICKUP_STATUS_TYPE.closed, CLICKUP_STATUS_TYPE.done],
  wont_fix: [CLICKUP_STATUS_TYPE.closed, CLICKUP_STATUS_TYPE.done],
  open: [CLICKUP_STATUS_TYPE.open],
  in_progress: [CLICKUP_STATUS_TYPE.custom, CLICKUP_STATUS_TYPE.open],
};

const ID_PATTERN = /^[\w-]+$/;

const isFinished = (type: string | undefined): boolean =>
  type === CLICKUP_STATUS_TYPE.closed || type === CLICKUP_STATUS_TYPE.done;

/**
 * The body as the hooks read it: the Markdown description, its first line
 * the marker turned back into an HTML comment, or the plain-text one when
 * only that still carries the marker.
 */
function bodyOf(task: ClickUpTask): string {
  const candidates = [task.markdown_description, task.description, task.text_content]
    .filter((text): text is string => typeof text === "string")
    .map(withHiddenMarker);
  return candidates.find((text) => parseIssueMarker(text) !== null) ?? candidates[0] ?? "";
}

/**
 * `IssueTracker` on ClickUp (API v2). Each feedback is a task in `listId`,
 * tagged `siteping`, its description Markdown whose first line is the
 * linking marker in a code span: ClickUp does not keep HTML comments.
 * Only tasks of that list and workspace are ever read as SitePing tasks.
 */
export function createClickUpTracker({
  listId,
  workspaceId,
  token,
  tokenType = "personal",
  statuses: statusNames = {},
  apiBaseUrl = CLICKUP_API_BASE_URL,
  fetch,
  timeoutMs,
  maxListedPages = TRACKER_MAX_LISTED_PAGES,
}: ClickUpTrackerOptions): ReadableIssueTracker {
  if (typeof listId !== "string" || !ID_PATTERN.test(listId)) {
    throw new Error("[siteping] createClickUpTracker: listId must be the list's id");
  }
  if (typeof workspaceId !== "string" || !ID_PATTERN.test(workspaceId)) {
    throw new Error("[siteping] createClickUpTracker: workspaceId must be the workspace's id");
  }
  const credential = checkToken("createClickUpTracker", token);
  checkApiBaseUrl("createClickUpTracker", apiBaseUrl);
  checkTimeout("createClickUpTracker", timeoutMs);
  checkPositiveInteger("createClickUpTracker", "maxListedPages", maxListedPages);
  const request = createJsonHttpClient({
    tracker: "ClickUp",
    baseUrl: `${apiBaseUrl.replace(/\/+$/, "")}${CLICKUP_API_PATH}`,
    headers: { Accept: "application/json", Authorization: tokenType === "oauth" ? `Bearer ${credential}` : credential },
    ...(fetch ? { fetch } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const taskPath = (id: string) => `/task/${encodeURIComponent(id)}`;
  const taskUrl = (task: ClickUpTask) => task.url ?? `https://app.clickup.com/t/${encodeURIComponent(task.id)}`;
  const wontFixName = statusNames.wont_fix?.toLowerCase();

  // Read once per tracker; a failed read is retried on the next call.
  let statusesRead: Promise<ClickUpStatus[]> | null = null;
  const listStatuses = (): Promise<ClickUpStatus[]> => {
    statusesRead ??= request<{ statuses?: ClickUpStatus[] }>({ method: "GET", path: `/list/${listId}` })
      .then(({ statuses = [] }) => [...statuses].sort((a, b) => Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0)))
      .catch((error: unknown) => {
        statusesRead = null;
        throw error;
      });
    return statusesRead;
  };

  /** Whether the task is in `listId` of `workspaceId`: any other task is not ours, whatever tag and marker it carries. */
  const inScope = (task: ClickUpTask): boolean =>
    task.list?.id !== undefined &&
    String(task.list.id) === listId &&
    task.team_id !== undefined &&
    task.team_id !== null &&
    String(task.team_id) === workspaceId;
  const isTagged = (task: ClickUpTask): boolean =>
    (task.tags ?? []).some((tag) => tag.name?.toLowerCase() === SITEPING_ISSUE_LABEL);

  const toTrackedIssue = (task: ClickUpTask): TrackedIssue => {
    const finished = isFinished(task.status?.type ?? undefined);
    const name = task.status?.status?.toLowerCase();
    return {
      reference: { key: task.id, url: taskUrl(task) },
      body: bodyOf(task),
      isOpen: !finished,
      // Without a named won't-fix status, a finished task says nothing about why.
      ...(finished && wontFixName !== undefined ? { closedAs: name === wontFixName ? "wont_fix" : "resolved" } : {}),
    };
  };

  return {
    name: "ClickUp",

    async createIssue({ title, body, labels }) {
      const markdown = withVisibleMarker(body);
      const task = await request<ClickUpTask>({
        method: "POST",
        path: `/list/${listId}/task`,
        // `markdown_content` wins over `description` where both are read.
        body: { name: title, markdown_content: markdown, description: markdown, tags: labels },
      });
      if (labels.includes(SITEPING_ISSUE_LABEL) && task.tags !== undefined && !isTagged(task)) {
        throw new UnlabelledIssueError(
          "ClickUp",
          task.id,
          "Check that the token's account may add tags in the list's space.",
        );
      }
      return { key: task.id, url: taskUrl(task) };
    },

    async updateIssueStatus(reference, status) {
      const available = await listStatuses();
      const named = statusNames[status]?.toLowerCase();
      const target =
        (named ? available.find((candidate) => candidate.status.toLowerCase() === named) : undefined) ??
        STATUS_TYPES[status].map((type) => available.find((candidate) => candidate.type === type)).find(Boolean);
      if (!target) throw new Error(`[siteping] ClickUp: the list has no status for feedback status "${status}"`);
      await request({ method: "PUT", path: taskPath(reference.key), body: { status: target.status } });
    },

    async addComment(reference, body) {
      await request({
        method: "POST",
        path: `${taskPath(reference.key)}/comment`,
        body: { comment_text: body, notify_all: false },
      });
    },

    async listComments(reference) {
      const bodies: string[] = [];
      let cursor: { start: string; start_id: string } | undefined;
      for (let page = 1; page <= maxListedPages; page++) {
        const { comments = [] } = await request<{
          comments?: Array<{ id?: string; date?: string | number; comment_text?: string | null }>;
        }>({ method: "GET", path: `${taskPath(reference.key)}/comment`, ...(cursor ? { query: cursor } : {}) });
        bodies.push(...comments.map((comment) => comment.comment_text ?? ""));
        const last = comments.at(-1);
        // Newest first, 25 at a time; the last comment's date and id ask for the ones before it.
        if (comments.length < CLICKUP_COMMENT_PAGE_SIZE || !last?.id || last.date === undefined) break;
        cursor = { start: String(last.date), start_id: last.id };
      }
      return bodies;
    },

    async findSitepingIssues(marker, { maxPages = maxListedPages } = {}) {
      const issues: TrackedIssue[] = [];
      const pages = Math.min(maxPages, maxListedPages);
      for (let page = 0; page < pages; page++) {
        const answer = await request<{ tasks?: ClickUpTask[]; last_page?: boolean }>({
          method: "GET",
          path: `/list/${listId}/task`,
          query: {
            page: String(page),
            order_by: "created",
            include_closed: "true",
            include_markdown_description: "true",
            "tags[]": SITEPING_ISSUE_LABEL,
          },
        });
        const tasks = answer.tasks ?? [];
        // The endpoint scopes to the list and tag already; checked again on what comes back.
        for (const task of tasks) {
          if (!inScope(task) || !isTagged(task)) continue;
          const issue = toTrackedIssue(task);
          if (issue.body.includes(marker)) issues.push(issue);
        }
        if (answer.last_page !== false || tasks.length < CLICKUP_TASK_PAGE_SIZE) return { issues, truncated: false };
      }
      return { issues, truncated: true };
    },

    async getIssue(key) {
      // A key from a delivery: anything but an id is no task of ours.
      if (typeof key !== "string" || !ID_PATTERN.test(key)) return null;
      let task: ClickUpTask;
      try {
        task = await request<ClickUpTask>({
          method: "GET",
          path: taskPath(key),
          query: { include_markdown_description: "true" },
        });
      } catch (error) {
        if (isIssueTrackerRequestError(error) && error.status === 404) return null;
        throw error;
      }
      return inScope(task) && isTagged(task) ? toTrackedIssue(task) : null;
    },
  };
}

export interface ClickUpWebhookOptions extends IssueWebhookOptions {
  /** The tracker the tasks were opened with: each delivery's task is read back through it. */
  tracker: ReadableIssueTracker;
}

/**
 * Two-way sync from ClickUp: a Fetch API handler for a ClickUp webhook on
 * the `taskStatusUpdated` event, with `secret` the webhook's own (returned
 * when it is created). It checks the `X-Signature` HMAC of the raw body,
 * then reads the task through `tracker` — never the delivery's status,
 * which may be stale — and moves its feedback to `resolved` (a `closed` or
 * `done` status), `wont_fix` (the tracker's `statuses.wont_fix`) or back to
 * `open`. A task outside the tracker's list and workspace is ignored.
 */
export function createClickUpWebhookHandler({
  tracker,
  ...options
}: ClickUpWebhookOptions): (request: Request) => Promise<Response> {
  const { secret } = options;
  return createWebhookHandler(
    {
      tracker: "ClickUp",
      factory: "createClickUpWebhookHandler",
      verify: (request, body) => verifyHexSignature(secret, body, request.headers.get(CLICKUP_SIGNATURE_HEADER)),
      async issueOf(payload) {
        const { event, task_id: taskId } = asRecord(payload);
        if (event !== CLICKUP_STATUS_EVENT || typeof taskId !== "string") return null;
        return tracker.getIssue(taskId);
      },
    },
    options,
  );
}

export type { IssueReference, IssueTracker, ReadableIssueTracker } from "../core/issue-tracker.js";
export type { IssueStatusSync, IssueWebhookOptions, IssueWebhookStore } from "../core/webhook.js";
