import type { FeedbackStatus } from "@siteping/core";
import { TRACKER_MAX_LISTED_PAGES } from "../constants/http.js";
import { SITEPING_ISSUE_LABEL } from "../constants/issue-format.js";
import {
  PLANE_API_BASE_URL,
  PLANE_APP_BASE_URL,
  PLANE_PAGE_SIZE,
  PLANE_SIGNATURE_HEADER,
  PLANE_STATE_GROUP,
  PLANE_USER_AGENT,
} from "../constants/plane.js";
import { createJsonHttpClient, isIssueTrackerRequestError, UnlabelledIssueError } from "../core/http-client.js";
import type { ReadableIssueTracker, TrackedIssue } from "../core/issue-tracker.js";
import { htmlToText, markdownToHtml, withVisibleMarker } from "../core/rich-text.js";
import { checkApiBaseUrl, checkPositiveInteger, checkTimeout, checkToken } from "../core/tracker-options.js";
import { asRecord, createWebhookHandler, type IssueWebhookOptions, verifyHexSignature } from "../core/webhook.js";

export interface PlaneTrackerOptions {
  /** The workspace slug, as in `https://app.plane.so/<slug>/projects/`. */
  workspaceSlug: string;
  /** Id (UUID) of the project work items are created in. */
  projectId: string;
  /** A personal access token (`plane_api_…`), sent as `X-API-Key`. */
  apiKey: string;
  /**
   * State names to use instead of the first state of the matching group:
   * `resolved` → completed, `wont_fix` → cancelled, `open` → unstarted,
   * `in_progress` → started. Matched case-insensitively.
   */
  states?: Partial<Record<FeedbackStatus, string>> | undefined;
  /** API root of a self-hosted instance, e.g. `https://plane.acme.com`. Defaults to Plane Cloud. */
  apiBaseUrl?: string | undefined;
  /**
   * Web app root that issue links point to. Defaults to `https://app.plane.so`
   * on Plane Cloud, and to `apiBaseUrl` otherwise (self-hosted instances
   * serve both from one origin).
   */
  appBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Most pages of 100 work items listed — see the GitHub tracker's option of the same name. Defaults to 10. */
  maxListedPages?: number | undefined;
}

interface PlaneState {
  id: string;
  name: string;
  group: string;
  sequence?: number;
}

interface PlaneWorkItem {
  id: string;
  sequence_id?: number;
  description_html?: string | null;
  state?: string | null;
  labels?: string[];
}

/** One page of a list endpoint: Plane paginates with cursors, and some endpoints answer a bare array. */
interface PlanePage<Item> {
  results?: Item[];
  next_cursor?: string | null;
  next_page_results?: boolean;
}

const pageItems = <Item>(page: PlanePage<Item> | Item[]): Item[] => (Array.isArray(page) ? page : (page.results ?? []));
const hasNextPage = (page: PlanePage<unknown> | unknown[]): boolean =>
  !Array.isArray(page) && page.next_page_results === true && Boolean(page.next_cursor);

/** The state group each feedback status moves a work item to, best first. */
const STATE_GROUPS: Record<FeedbackStatus, readonly string[]> = {
  resolved: [PLANE_STATE_GROUP.completed],
  wont_fix: [PLANE_STATE_GROUP.cancelled, PLANE_STATE_GROUP.completed],
  open: [PLANE_STATE_GROUP.unstarted, PLANE_STATE_GROUP.backlog],
  in_progress: [PLANE_STATE_GROUP.started, PLANE_STATE_GROUP.unstarted],
};

const ID_PATTERN = /^[\w-]+$/;

/**
 * `IssueTracker` on Plane (REST API v1 work items, Cloud or self-hosted).
 * Descriptions and comments go as HTML; the linking marker is the
 * description's first paragraph, in code, which Plane's editor keeps.
 * Every request sends a User-Agent: Plane refuses requests without one.
 */
export function createPlaneTracker({
  workspaceSlug,
  projectId,
  apiKey,
  states: stateNames = {},
  apiBaseUrl = PLANE_API_BASE_URL,
  appBaseUrl,
  fetch,
  timeoutMs,
  maxListedPages = TRACKER_MAX_LISTED_PAGES,
}: PlaneTrackerOptions): ReadableIssueTracker {
  if (typeof workspaceSlug !== "string" || !ID_PATTERN.test(workspaceSlug)) {
    throw new Error("[siteping] createPlaneTracker: workspaceSlug must be the workspace's slug");
  }
  if (typeof projectId !== "string" || !ID_PATTERN.test(projectId)) {
    throw new Error("[siteping] createPlaneTracker: projectId must be the project's id");
  }
  const credential = checkToken("createPlaneTracker", apiKey);
  checkApiBaseUrl("createPlaneTracker", apiBaseUrl);
  if (appBaseUrl !== undefined) checkApiBaseUrl("createPlaneTracker", appBaseUrl);
  checkTimeout("createPlaneTracker", timeoutMs);
  checkPositiveInteger("createPlaneTracker", "maxListedPages", maxListedPages);
  const request = createJsonHttpClient({
    tracker: "Plane",
    baseUrl: apiBaseUrl,
    headers: { Accept: "application/json", "X-API-Key": credential, "User-Agent": PLANE_USER_AGENT },
    ...(fetch ? { fetch } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const app = (appBaseUrl ?? (apiBaseUrl === PLANE_API_BASE_URL ? PLANE_APP_BASE_URL : apiBaseUrl)).replace(/\/+$/, "");
  const projectPath = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}`;
  const itemPath = (id: string) => `${projectPath}/work-items/${encodeURIComponent(id)}/`;
  const itemUrl = (id: string) => `${app}/${workspaceSlug}/projects/${projectId}/issues/${id}`;

  /** Every item of a list endpoint, up to `pages` pages. */
  const listAll = async <Item>(path: string, pages: number, query: Record<string, string> = {}) => {
    const items: Item[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= pages; page++) {
      const answer = await request<PlanePage<Item> | Item[]>({
        method: "GET",
        path,
        query: { per_page: String(PLANE_PAGE_SIZE), ...query, ...(cursor ? { cursor } : {}) },
      });
      items.push(...pageItems(answer));
      if (!hasNextPage(answer)) return { items, truncated: false };
      cursor = (answer as PlanePage<Item>).next_cursor ?? undefined;
    }
    return { items, truncated: true };
  };

  // Read once per tracker; a failed read is retried on the next call.
  let statesRead: Promise<PlaneState[]> | null = null;
  const projectStates = (): Promise<PlaneState[]> => {
    statesRead ??= listAll<PlaneState>(`${projectPath}/states/`, 1)
      .then(({ items }) => [...items].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)))
      .catch((error: unknown) => {
        statesRead = null;
        throw error;
      });
    return statesRead;
  };

  const labelIds = new Map<string, string>();
  const resolveLabels = async (names: readonly string[]): Promise<string[]> => {
    if (names.some((name) => !labelIds.has(name.toLowerCase()))) {
      const { items } = await listAll<{ id: string; name: string }>(`${projectPath}/labels/`, maxListedPages);
      for (const label of items) labelIds.set(label.name.toLowerCase(), label.id);
    }
    for (const name of names) {
      if (labelIds.has(name.toLowerCase())) continue;
      const label = await request<{ id: string }>({ method: "POST", path: `${projectPath}/labels/`, body: { name } });
      labelIds.set(name.toLowerCase(), label.id);
    }
    return names.map((name) => labelIds.get(name.toLowerCase()) as string);
  };

  const toTrackedIssue = async (item: PlaneWorkItem): Promise<TrackedIssue> => {
    const group = (await projectStates()).find((state) => state.id === item.state)?.group;
    const closed = group === PLANE_STATE_GROUP.completed || group === PLANE_STATE_GROUP.cancelled;
    return {
      reference: { key: item.id, url: itemUrl(item.id) },
      body: htmlToText(item.description_html ?? ""),
      isOpen: !closed,
      ...(closed ? { closedAs: group === PLANE_STATE_GROUP.cancelled ? "wont_fix" : "resolved" } : {}),
    };
  };

  const sitepingLabelId = async (): Promise<string> => (await resolveLabels([SITEPING_ISSUE_LABEL]))[0] as string;

  return {
    name: "Plane",

    async createIssue({ title, body, labels }) {
      const ids = await resolveLabels(labels);
      const item = await request<PlaneWorkItem>({
        method: "POST",
        path: `${projectPath}/work-items/`,
        body: { name: title, description_html: markdownToHtml(withVisibleMarker(body)), labels: ids },
      });
      if (labels.includes(SITEPING_ISSUE_LABEL) && !(item.labels ?? []).includes(await sitepingLabelId())) {
        throw new UnlabelledIssueError(
          "Plane",
          item.sequence_id === undefined ? item.id : `#${item.sequence_id}`,
          "Check that the API key's account may label work items in the project.",
        );
      }
      return { key: item.id, url: itemUrl(item.id) };
    },

    async updateIssueStatus(reference, status) {
      const states = await projectStates();
      const named = stateNames[status]?.toLowerCase();
      const state =
        (named ? states.find((candidate) => candidate.name.toLowerCase() === named) : undefined) ??
        STATE_GROUPS[status].map((group) => states.find((candidate) => candidate.group === group)).find(Boolean);
      if (!state) throw new Error(`[siteping] Plane: the project has no state for feedback status "${status}"`);
      await request({ method: "PATCH", path: itemPath(reference.key), body: { state: state.id } });
    },

    async addComment(reference, body) {
      await request({
        method: "POST",
        path: `${itemPath(reference.key)}comments/`,
        body: { comment_html: markdownToHtml(withVisibleMarker(body)) },
      });
    },

    async listComments(reference) {
      const { items } = await listAll<{ comment_html?: string | null }>(
        `${itemPath(reference.key)}comments/`,
        maxListedPages,
      );
      return items.map((comment) => htmlToText(comment.comment_html ?? ""));
    },

    async findSitepingIssues(marker, { maxPages = maxListedPages } = {}) {
      const { items, truncated } = await listAll<PlaneWorkItem>(
        `${projectPath}/work-items/`,
        Math.min(maxPages, maxListedPages),
        { order_by: "-created_at" },
      );
      const label = await sitepingLabelId();
      const labelled = items.filter((item) => (item.labels ?? []).includes(label));
      const issues = await Promise.all(labelled.map(toTrackedIssue));
      return { issues: issues.filter((issue) => issue.body.includes(marker)), truncated };
    },

    async getIssue(key) {
      let item: PlaneWorkItem;
      try {
        item = await request<PlaneWorkItem>({ method: "GET", path: itemPath(key) });
      } catch (error) {
        if (isIssueTrackerRequestError(error) && error.status === 404) return null;
        throw error;
      }
      return (item.labels ?? []).includes(await sitepingLabelId()) ? toTrackedIssue(item) : null;
    },
  };
}

export interface PlaneWebhookOptions extends IssueWebhookOptions {
  /** The tracker the work items were opened with: each delivery's work item is read back through it. */
  tracker: ReadableIssueTracker;
}

/** The work item a delivery changed the state of, or `null`. Reads both payload versions Plane sends. */
function changedWorkItem(payload: unknown): string | null {
  const { event, action, entity_type, entity_id, data, activity, previous_attributes } = asRecord(payload);
  // Version 2: `entity_type` and `previous_attributes`, holding the previous value of each changed field.
  if (entity_type === "issue" && typeof entity_id === "string") {
    const previous = asRecord(previous_attributes);
    return "state_id" in previous || "state" in previous ? entity_id : null;
  }
  // Version 1: `event: "issue"`, the changed field in `activity`.
  if (event === "issue" && action === "updated" && asRecord(activity).field === "state") {
    const id = asRecord(data).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * Two-way sync from Plane: a Fetch API handler for a Plane webhook on work
 * item events. It checks the `X-Plane-Signature` HMAC, and when a delivery
 * changed a work item's state, reads it through `tracker` and moves its
 * feedback to `resolved` (completed group), `wont_fix` (cancelled) or back
 * to `open`.
 */
export function createPlaneWebhookHandler({
  tracker,
  ...options
}: PlaneWebhookOptions): (request: Request) => Promise<Response> {
  const { secret } = options;
  return createWebhookHandler(
    {
      tracker: "Plane",
      factory: "createPlaneWebhookHandler",
      verify: (request, body) => verifyHexSignature(secret, body, request.headers.get(PLANE_SIGNATURE_HEADER)),
      async issueOf(payload) {
        const id = changedWorkItem(payload);
        return id ? tracker.getIssue(id) : null;
      },
    },
    options,
  );
}

export type { IssueReference, IssueTracker, ReadableIssueTracker } from "../core/issue-tracker.js";
export type { IssueStatusSync, IssueWebhookOptions, IssueWebhookStore } from "../core/webhook.js";
