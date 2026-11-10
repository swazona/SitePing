import type { FeedbackStatus } from "@siteping/core";
import { TRACKER_MAX_LISTED_PAGES } from "../constants/http.js";
import { SITEPING_ISSUE_LABEL } from "../constants/issue-format.js";
import {
  LINEAR_API_BASE_URL,
  LINEAR_GRAPHQL_PATH,
  LINEAR_PAGE_SIZE,
  LINEAR_SIGNATURE_HEADER,
  LINEAR_STATE_TYPE,
} from "../constants/linear.js";
import { LINEAR_WEBHOOK_TOLERANCE_MS } from "../constants/webhooks.js";
import { createJsonHttpClient, IssueTrackerRequestError, UnlabelledIssueError } from "../core/http-client.js";
import type { ReadableIssueTracker, TrackedIssue } from "../core/issue-tracker.js";
import { withHiddenMarker, withVisibleMarker } from "../core/rich-text.js";
import { checkApiBaseUrl, checkPositiveInteger, checkTimeout, checkToken } from "../core/tracker-options.js";
import { asRecord, createWebhookHandler, type IssueWebhookOptions, verifyHexSignature } from "../core/webhook.js";

export interface LinearTrackerOptions {
  /** Id (UUID) of the team issues are created in. */
  teamId: string;
  /** A personal API key (`lin_api_…`), or an OAuth access token with `tokenType: "oauth"`. */
  token: string;
  /** `apiKey` (default) sends the token as is, `oauth` as `Bearer`. */
  tokenType?: "apiKey" | "oauth" | undefined;
  /**
   * Workflow state names to use instead of the first state of the matching
   * type (by position): `resolved` → completed, `wont_fix` → canceled,
   * `open` → unstarted, `in_progress` → started. Matched case-insensitively.
   */
  states?: Partial<Record<FeedbackStatus, string>> | undefined;
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Most pages of 100 issues listed — see the GitHub tracker's option of the same name. Defaults to 10. */
  maxListedPages?: number | undefined;
}

interface LinearState {
  id: string;
  name: string;
  type: string;
  position: number;
}

interface LinearIssue {
  id: string;
  url: string;
  description: string | null;
  state: { type: string } | null;
  labels: { nodes: Array<{ name: string }> };
}

interface Connection<Node> {
  nodes: Node[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const ISSUE_FIELDS = "id url description state { type } labels { nodes { name } }";

/** The state type each feedback status moves a Linear issue to, best first. */
const STATE_TYPES: Record<FeedbackStatus, readonly string[]> = {
  resolved: [LINEAR_STATE_TYPE.completed],
  wont_fix: [LINEAR_STATE_TYPE.canceled, LINEAR_STATE_TYPE.completed],
  open: [LINEAR_STATE_TYPE.unstarted, LINEAR_STATE_TYPE.backlog, LINEAR_STATE_TYPE.triage],
  in_progress: [LINEAR_STATE_TYPE.started, LINEAR_STATE_TYPE.unstarted],
};

const hasSitepingLabel = (issue: LinearIssue): boolean =>
  issue.labels.nodes.some((label) => label.name.toLowerCase() === SITEPING_ISSUE_LABEL);

function toTrackedIssue(issue: LinearIssue): TrackedIssue {
  const type = issue.state?.type;
  const closed = type === LINEAR_STATE_TYPE.completed || type === LINEAR_STATE_TYPE.canceled;
  return {
    reference: { key: issue.id, url: issue.url },
    body: withHiddenMarker(issue.description ?? ""),
    isOpen: !closed,
    ...(closed ? { closedAs: type === LINEAR_STATE_TYPE.canceled ? "wont_fix" : "resolved" } : {}),
  };
}

/**
 * `IssueTracker` on Linear, through its GraphQL API. Issues carry the
 * `siteping` label (created in the team when missing) and the linking
 * marker as their description's first line, in a code span: Linear does not
 * keep HTML comments.
 */
export function createLinearTracker({
  teamId,
  token,
  tokenType = "apiKey",
  states: stateNames = {},
  apiBaseUrl = LINEAR_API_BASE_URL,
  fetch,
  timeoutMs,
  maxListedPages = TRACKER_MAX_LISTED_PAGES,
}: LinearTrackerOptions): ReadableIssueTracker {
  if (typeof teamId !== "string" || !/^[\w-]+$/.test(teamId)) {
    throw new Error("[siteping] createLinearTracker: teamId must be the team's id");
  }
  const credential = checkToken("createLinearTracker", token);
  checkApiBaseUrl("createLinearTracker", apiBaseUrl);
  checkTimeout("createLinearTracker", timeoutMs);
  checkPositiveInteger("createLinearTracker", "maxListedPages", maxListedPages);
  const request = createJsonHttpClient({
    tracker: "Linear",
    baseUrl: apiBaseUrl,
    headers: { Authorization: tokenType === "oauth" ? `Bearer ${credential}` : credential },
    ...(fetch ? { fetch } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  /** GraphQL errors come back with a 200: raised like a failed request, the messages as the cause. */
  const graphql = async <Data>(query: string, variables: Record<string, unknown>): Promise<Data> => {
    const answer = await request<{ data?: Data | null; errors?: Array<{ message?: string }> }>({
      method: "POST",
      path: LINEAR_GRAPHQL_PATH,
      body: { query, variables },
    });
    if (answer?.errors?.length || !answer?.data) {
      throw new IssueTrackerRequestError("Linear", "POST", LINEAR_GRAPHQL_PATH, 200, {
        cause: answer?.errors?.map((error) => error.message),
      });
    }
    return answer.data;
  };

  const mutationFailed = (name: string) =>
    new IssueTrackerRequestError("Linear", "POST", LINEAR_GRAPHQL_PATH, 200, {
      cause: `${name} returned success: false`,
    });

  // Read once per tracker; a failed read is retried on the next call.
  let statesRead: Promise<LinearState[]> | null = null;
  const teamStates = (): Promise<LinearState[]> => {
    statesRead ??= graphql<{ team: { states: { nodes: LinearState[] } } }>(
      "query SitepingStates($teamId: String!) { team(id: $teamId) { states(first: 100) { nodes { id name type position } } } }",
      { teamId },
    )
      .then((data) => [...data.team.states.nodes].sort((a, b) => a.position - b.position))
      .catch((error: unknown) => {
        statesRead = null;
        throw error;
      });
    return statesRead;
  };

  const labelIds = new Map<string, string>();
  /** Ids of `names` among the team's and the workspace's labels, the missing ones created in the team. */
  const resolveLabels = async (names: readonly string[]): Promise<string[]> => {
    const missing = names.filter((name) => !labelIds.has(name.toLowerCase()));
    if (missing.length > 0) {
      const { issueLabels } = await graphql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
        "query SitepingLabels($filter: IssueLabelFilter) { issueLabels(first: 250, filter: $filter) { nodes { id name } } }",
        {
          filter: {
            and: [
              { or: missing.map((name) => ({ name: { eqIgnoreCase: name } })) },
              { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
            ],
          },
        },
      );
      for (const label of issueLabels.nodes) labelIds.set(label.name.toLowerCase(), label.id);
      for (const name of missing) {
        if (labelIds.has(name.toLowerCase())) continue;
        const { issueLabelCreate } = await graphql<{
          issueLabelCreate: { success: boolean; issueLabel: { id: string } | null };
        }>(
          "mutation SitepingLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }",
          { input: { name, teamId } },
        );
        if (!issueLabelCreate.success || !issueLabelCreate.issueLabel) throw mutationFailed("issueLabelCreate");
        labelIds.set(name.toLowerCase(), issueLabelCreate.issueLabel.id);
      }
    }
    return names.map((name) => labelIds.get(name.toLowerCase()) as string);
  };

  /** Pages of the team's SitePing issues matching `extra`, newest first. */
  const listIssues = async (
    extra: Record<string, unknown>,
    pages: number,
  ): Promise<{ issues: LinearIssue[]; truncated: boolean }> => {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 1; page <= pages; page++) {
      const data: { issues: Connection<LinearIssue> } = await graphql(
        `query SitepingIssues($filter: IssueFilter, $after: String) { issues(first: ${LINEAR_PAGE_SIZE}, after: $after, filter: $filter, orderBy: createdAt, includeArchived: true) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        {
          filter: {
            team: { id: { eq: teamId } },
            labels: { some: { name: { eqIgnoreCase: SITEPING_ISSUE_LABEL } } },
            ...extra,
          },
          after,
        },
      );
      issues.push(...data.issues.nodes);
      if (!data.issues.pageInfo.hasNextPage) return { issues, truncated: false };
      after = data.issues.pageInfo.endCursor;
    }
    return { issues, truncated: true };
  };

  return {
    name: "Linear",

    async createIssue({ title, body, labels }) {
      const ids = await resolveLabels(labels);
      const { issueCreate } = await graphql<{
        issueCreate: {
          success: boolean;
          issue: { id: string; identifier: string; url: string; labels: { nodes: Array<{ name: string }> } } | null;
        };
      }>(
        "mutation SitepingIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url labels { nodes { name } } } } }",
        { input: { teamId, title, description: withVisibleMarker(body), labelIds: ids } },
      );
      const issue = issueCreate.issue;
      if (!issueCreate.success || !issue) throw mutationFailed("issueCreate");
      if (
        labels.includes(SITEPING_ISSUE_LABEL) &&
        !issue.labels.nodes.some((label) => label.name.toLowerCase() === SITEPING_ISSUE_LABEL)
      ) {
        throw new UnlabelledIssueError(
          "Linear",
          issue.identifier,
          "Check that the token may label issues in the team.",
        );
      }
      return { key: issue.id, url: issue.url };
    },

    async updateIssueStatus(reference, status) {
      const states = await teamStates();
      const named = stateNames[status]?.toLowerCase();
      const state =
        (named ? states.find((candidate) => candidate.name.toLowerCase() === named) : undefined) ??
        STATE_TYPES[status].map((type) => states.find((candidate) => candidate.type === type)).find(Boolean);
      if (!state) {
        throw new Error(`[siteping] Linear: the team has no workflow state for feedback status "${status}"`);
      }
      const { issueUpdate } = await graphql<{ issueUpdate: { success: boolean } }>(
        "mutation SitepingIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        { id: reference.key, input: { stateId: state.id } },
      );
      if (!issueUpdate.success) throw mutationFailed("issueUpdate");
    },

    async addComment(reference, body) {
      const { commentCreate } = await graphql<{ commentCreate: { success: boolean } }>(
        "mutation SitepingCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        { input: { issueId: reference.key, body: withVisibleMarker(body) } },
      );
      if (!commentCreate.success) throw mutationFailed("commentCreate");
    },

    async listComments(reference) {
      const bodies: string[] = [];
      let after: string | null = null;
      for (let page = 1; page <= maxListedPages; page++) {
        const data: { issue: { comments: Connection<{ body: string }> } } = await graphql(
          `query SitepingComments($id: String!, $after: String) { issue(id: $id) { comments(first: ${LINEAR_PAGE_SIZE}, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } } }`,
          { id: reference.key, after },
        );
        bodies.push(...data.issue.comments.nodes.map((comment) => withHiddenMarker(comment.body)));
        if (!data.issue.comments.pageInfo.hasNextPage) break;
        after = data.issue.comments.pageInfo.endCursor;
      }
      return bodies;
    },

    async searchSitepingIssues(feedbackId) {
      const { issues, truncated } = await listIssues({ description: { contains: feedbackId } }, 1);
      return { issues: issues.map(toTrackedIssue), truncated };
    },

    async findSitepingIssues(marker, { maxPages = maxListedPages } = {}) {
      const { issues, truncated } = await listIssues({}, Math.min(maxPages, maxListedPages));
      const matches = issues.map(toTrackedIssue).filter((issue) => issue.body.includes(marker));
      return { issues: matches, truncated };
    },

    async getIssue(key) {
      let data: { issue: LinearIssue | null };
      try {
        data = await graphql(`query SitepingIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: key });
      } catch (error) {
        // Linear answers an unknown id with a GraphQL error.
        const messages = error instanceof IssueTrackerRequestError ? error.cause : undefined;
        if (Array.isArray(messages) && messages.some((message) => /not found/i.test(String(message)))) return null;
        throw error;
      }
      return data.issue && hasSitepingLabel(data.issue) ? toTrackedIssue(data.issue) : null;
    },
  };
}

export interface LinearWebhookOptions extends IssueWebhookOptions {
  /** The tracker the issues were opened with: each delivery's issue is read back through it. */
  tracker: ReadableIssueTracker;
  /**
   * How long after it was sent a delivery is accepted, in milliseconds
   * (`webhookTimestamp`), against replays. Defaults to 60 seconds, as
   * Linear recommends.
   */
  toleranceMs?: number | undefined;
}

/**
 * Two-way sync from Linear: a Fetch API handler for a Linear webhook on
 * `Issue` events. It checks the `Linear-Signature` HMAC and the delivery's
 * age, and when an issue's state changed, reads the issue through `tracker`
 * and moves its feedback to `resolved` (completed), `wont_fix` (canceled)
 * or back to `open`.
 */
export function createLinearWebhookHandler({
  tracker,
  toleranceMs = LINEAR_WEBHOOK_TOLERANCE_MS,
  ...options
}: LinearWebhookOptions): (request: Request) => Promise<Response> {
  checkPositiveInteger("createLinearWebhookHandler", "toleranceMs", toleranceMs);
  const { secret } = options;
  return createWebhookHandler(
    {
      tracker: "Linear",
      factory: "createLinearWebhookHandler",
      async verify(request, body) {
        if (!(await verifyHexSignature(secret, body, request.headers.get(LINEAR_SIGNATURE_HEADER)))) return false;
        // Signed, so the timestamp in it is Linear's.
        try {
          const sentAt = Number(asRecord(JSON.parse(new TextDecoder().decode(body))).webhookTimestamp);
          return Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) <= toleranceMs;
        } catch {
          return false;
        }
      },
      async issueOf(payload) {
        const { type, action, data, updatedFrom } = asRecord(payload);
        if (type !== "Issue" || action !== "update" || !("stateId" in asRecord(updatedFrom))) return null;
        const id = asRecord(data).id;
        return typeof id === "string" ? tracker.getIssue(id) : null;
      },
    },
    options,
  );
}

export type { IssueReference, IssueTracker, ReadableIssueTracker } from "../core/issue-tracker.js";
export type { IssueStatusSync, IssueWebhookOptions, IssueWebhookStore } from "../core/webhook.js";
