/**
 * In-memory stand-ins for the Linear (GraphQL), Jira Cloud (REST v3) and
 * Plane (REST v1) APIs, injected as `fetch`. They implement only what the
 * trackers call, in the request/response shapes of the real APIs as far as
 * their public docs describe them, and record every request.
 */
import { adfToText, htmlToText } from "../src/core/rich-text.js";

export interface SaasIssue {
  key: string;
  title: string;
  /** Description in the tracker's own format: Markdown (Linear), ADF (Jira), HTML (Plane). */
  description: unknown;
  labels: string[];
  /** Linear state type, Jira status category, Plane state group. */
  stateKind: string;
  /** Jira only: the resolution of a done issue. */
  resolution?: string | null;
  comments: unknown[];
  /** The issue's team id (Linear), project key (Jira) or project id (Plane), when not the fake's own. */
  scope?: string;
}

export interface SaasFake {
  fetch: typeof fetch;
  issues: SaasIssue[];
  requests: Array<{ method: string; path: string; headers: Headers; body: unknown }>;
  /** Make every request whose `METHOD path` (or GraphQL operation name) matches answer with this status. */
  failWhen(pattern: RegExp, status: number): void;
  /** Text of an issue's description, as a reader would see it. */
  descriptionText(issue: SaasIssue): string;
  commentText(comment: unknown): string;
}

function base(handle: (request: Request, body: unknown, route: string) => Response | Promise<Response>) {
  const requests: SaasFake["requests"] = [];
  const failures: Array<{ pattern: RegExp; status: number }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    requests.push({ method: request.method, path: url.pathname + url.search, headers: request.headers, body });
    const operation = (body as { query?: string } | undefined)?.query?.match(/(?:query|mutation) (\w+)/)?.[1];
    const route = `${request.method} ${url.pathname}${operation ? ` ${operation}` : ""}`;
    const failure = failures.find(({ pattern }) => pattern.test(route));
    if (failure) return new Response("refused", { status: failure.status });
    return handle(request, body, route);
  };
  return {
    fetch: fakeFetch,
    requests,
    failWhen: (pattern: RegExp, status: number) => failures.push({ pattern, status }),
  };
}

// --- Linear ---

const LINEAR_STATES = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-progress", name: "In Progress", type: "started", position: 2 },
  { id: "st-done", name: "Done", type: "completed", position: 3 },
  { id: "st-canceled", name: "Canceled", type: "canceled", position: 4 },
  { id: "st-duplicate", name: "Duplicate", type: "canceled", position: 5 },
];

export function createFakeLinear(teamId = "team-1"): SaasFake & { labelCatalog: Map<string, string> } {
  const issues: SaasIssue[] = [];
  const labelCatalog = new Map<string, string>(); // id → name
  let nextId = 0;
  const data = (payload: unknown) => Response.json({ data: payload });
  const issueNode = (issue: SaasIssue) => ({
    id: issue.key,
    url: `https://linear.app/acme/issue/ENG-${issue.key.slice(6)}`,
    description: issue.description,
    state: { type: issue.stateKind },
    labels: { nodes: issue.labels.map((id) => ({ name: labelCatalog.get(id) })) },
    team: { id: issue.scope ?? teamId },
  });
  const find = (id: string) => issues.find((issue) => issue.key === id);

  const server = base((request, raw) => {
    if (request.headers.get("authorization") === null) return new Response("unauthorized", { status: 401 });
    const { query, variables } = raw as { query: string; variables: Record<string, any> };
    const operation = query.match(/(?:query|mutation) (\w+)/)?.[1];
    switch (operation) {
      case "SitepingStates":
        return variables.teamId === teamId
          ? data({ team: { states: { nodes: LINEAR_STATES } } })
          : Response.json({ errors: [{ message: "Entity not found" }], data: null });
      case "SitepingLabels": {
        const names: string[] = variables.filter.and[0].or.map((clause: any) => clause.name.eqIgnoreCase.toLowerCase());
        const nodes = [...labelCatalog].filter(([, name]) => names.includes(name.toLowerCase()));
        return data({ issueLabels: { nodes: nodes.map(([id, name]) => ({ id, name })) } });
      }
      case "SitepingLabelCreate": {
        const id = `label-${labelCatalog.size + 1}`;
        labelCatalog.set(id, variables.input.name);
        return data({ issueLabelCreate: { success: true, issueLabel: { id } } });
      }
      case "SitepingIssueCreate": {
        const { title, description, labelIds } = variables.input;
        nextId += 1;
        const issue: SaasIssue = {
          key: `issue-${nextId}`,
          title,
          description,
          labels: labelIds,
          stateKind: "unstarted",
          comments: [],
        };
        issues.push(issue);
        const node = issueNode(issue);
        return data({ issueCreate: { success: true, issue: { ...node, identifier: `ENG-${nextId}` } } });
      }
      case "SitepingIssueUpdate": {
        const issue = find(variables.id);
        const state = LINEAR_STATES.find((candidate) => candidate.id === variables.input.stateId);
        if (!issue || !state) return Response.json({ errors: [{ message: "Entity not found" }], data: null });
        issue.stateKind = state.type;
        return data({ issueUpdate: { success: true } });
      }
      case "SitepingCommentCreate": {
        find(variables.input.issueId)?.comments.push(variables.input.body);
        return data({ commentCreate: { success: true } });
      }
      case "SitepingComments": {
        const issue = find(variables.id);
        return data({
          issue: {
            comments: {
              nodes: (issue?.comments ?? []).map((body) => ({ body })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      case "SitepingIssues": {
        const filter = variables.filter;
        const start = variables.after ? Number(variables.after) : 0;
        const matching = [...issues]
          .reverse()
          .filter(() => filter.team.id.eq === teamId)
          .filter((issue) => issue.labels.some((id) => labelCatalog.get(id)?.toLowerCase() === "siteping"))
          .filter((issue) => !filter.description || String(issue.description).includes(filter.description.contains));
        const page = matching.slice(start, start + 100);
        const hasNextPage = start + 100 < matching.length;
        return data({
          issues: {
            nodes: page.map(issueNode),
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + 100) : null },
          },
        });
      }
      case "SitepingIssue": {
        const issue = find(variables.id);
        return issue
          ? data({ issue: issueNode(issue) })
          : Response.json({ errors: [{ message: "Entity not found: Issue" }], data: null });
      }
      default:
        return Response.json({ errors: [{ message: `unknown operation ${operation}` }] }, { status: 400 });
    }
  });
  return {
    ...server,
    issues,
    labelCatalog,
    descriptionText: (issue) => String(issue.description),
    commentText: (comment) => String(comment),
  };
}

// --- Jira ---

const JIRA_STATUSES = {
  "To Do": "new",
  "In Progress": "indeterminate",
  Done: "done",
} as const;

const JIRA_TRANSITIONS = [
  { id: "11", name: "To Do", to: "To Do", resolution: null },
  { id: "21", name: "In Progress", to: "In Progress", resolution: null },
  { id: "31", name: "Done", to: "Done", resolution: "Done" },
  { id: "41", name: "Won't Do", to: "Done", resolution: "Won't Do" },
] as const;

export function createFakeJira(projectKey = "WEB"): SaasFake {
  const issues: SaasIssue[] = [];
  /** The status of an issue, from its category: tests move issues by setting `stateKind`. */
  const statusOf = (issue: SaasIssue) =>
    (Object.keys(JIRA_STATUSES) as Array<keyof typeof JIRA_STATUSES>).find(
      (name) => JIRA_STATUSES[name] === issue.stateKind,
    ) ?? "To Do";
  const find = (key: string) => issues.find((issue) => issue.key === key);
  const fields = (issue: SaasIssue) => ({
    description: issue.description,
    status: { name: statusOf(issue), statusCategory: { key: issue.stateKind } },
    resolution: issue.resolution ? { name: issue.resolution } : null,
    labels: issue.labels,
    project: { key: issue.scope ?? projectKey },
  });

  const server = base((request, body: any, route) => {
    if (!request.headers.get("authorization")?.startsWith("Basic "))
      return new Response("unauthorized", { status: 401 });
    const path = new URL(request.url).pathname.replace("/rest/api/3", "");
    let match: RegExpMatchArray | null;
    if (route.startsWith("POST") && path === "/issue") {
      const { project, summary, description, labels, issuetype } = body.fields;
      if (project.key !== projectKey || !issuetype.name) return Response.json({ errors: {} }, { status: 400 });
      if (labels.some((label: string) => /\s/.test(label)))
        return Response.json({ errors: { labels: "spaces" } }, { status: 400 });
      const key = `${projectKey}-${issues.length + 1}`;
      issues.push({ key, title: summary, description, labels, stateKind: "new", resolution: null, comments: [] });
      return Response.json(
        { id: String(10_000 + issues.length), key, self: `https://acme.atlassian.net/rest/api/3/issue/${key}` },
        { status: 201 },
      );
    }
    match = path.match(/^\/issue\/([\w-]+)\/transitions$/);
    if (match) {
      const issue = find(match[1] as string);
      if (!issue) return new Response("not found", { status: 404 });
      if (route.startsWith("GET")) {
        const available = JIRA_TRANSITIONS.filter(
          (transition) => transition.to !== statusOf(issue) || transition.resolution !== issue.resolution,
        );
        return Response.json({
          transitions: available.map((transition) => ({
            id: transition.id,
            name: transition.name,
            to: { name: transition.to, statusCategory: { key: JIRA_STATUSES[transition.to] } },
          })),
        });
      }
      const transition = JIRA_TRANSITIONS.find((candidate) => candidate.id === body.transition.id);
      if (!transition) return new Response("bad transition", { status: 400 });
      issue.stateKind = JIRA_STATUSES[transition.to];
      issue.resolution = transition.resolution;
      return new Response(null, { status: 204 });
    }
    match = path.match(/^\/issue\/([\w-]+)\/comment$/);
    if (match) {
      const issue = find(match[1] as string);
      if (!issue) return new Response("not found", { status: 404 });
      if (route.startsWith("POST")) {
        issue.comments.push(body.body);
        return Response.json({ id: String(issue.comments.length) }, { status: 201 });
      }
      return Response.json({
        comments: issue.comments.map((comment) => ({ body: comment })),
        total: issue.comments.length,
      });
    }
    match = path.match(/^\/issue\/([\w-]+)$/);
    if (match) {
      const issue = find(match[1] as string);
      if (!issue) return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
      return Response.json({ id: "1", key: issue.key, fields: fields(issue) });
    }
    if (route.startsWith("POST") && path === "/search/jql") {
      const jql: string = body.jql;
      const text = jql.match(/text ~ "\\"(.*?)\\""/)?.[1];
      const matching = [...issues]
        .reverse()
        .filter((issue) => jql.includes(`project = "${projectKey}"`) && issue.labels.includes("siteping"))
        .filter((issue) => !text || adfToText(issue.description).includes(text));
      const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
      const page = matching.slice(start, start + body.maxResults);
      const isLast = start + body.maxResults >= matching.length;
      return Response.json({
        issues: page.map((issue) => ({ id: "1", key: issue.key, fields: fields(issue) })),
        isLast,
        ...(isLast ? {} : { nextPageToken: String(start + body.maxResults) }),
      });
    }
    return new Response(`no route ${route}`, { status: 404 });
  });
  return {
    ...server,
    issues,
    descriptionText: (issue) => adfToText(issue.description),
    commentText: (comment) => adfToText(comment),
  };
}

// --- Plane ---

const PLANE_STATES = [
  { id: "ps-backlog", name: "Backlog", group: "backlog", sequence: 1 },
  { id: "ps-todo", name: "Todo", group: "unstarted", sequence: 2 },
  { id: "ps-progress", name: "In Progress", group: "started", sequence: 3 },
  { id: "ps-done", name: "Done", group: "completed", sequence: 4 },
  { id: "ps-cancelled", name: "Cancelled", group: "cancelled", sequence: 5 },
];

export function createFakePlane(
  workspaceSlug = "acme",
  projectId = "proj-1",
): SaasFake & { labels: Map<string, string> } {
  const issues: SaasIssue[] = [];
  const labels = new Map<string, string>(); // id → name
  const prefix = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}`;
  const find = (id: string) => issues.find((issue) => issue.key === id);
  const stateId = (group: string) => PLANE_STATES.find((state) => state.group === group)?.id;
  const item = (issue: SaasIssue) => ({
    id: issue.key,
    sequence_id: Number(issue.key.slice(3)),
    name: issue.title,
    description_html: issue.description,
    state: stateId(issue.stateKind),
    labels: issue.labels,
    project: issue.scope ?? projectId,
  });
  const page = <Item>(items: Item[], url: URL) => {
    const perPage = Number(url.searchParams.get("per_page") ?? 100);
    const offset = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
    const results = items.slice(offset * perPage, (offset + 1) * perPage);
    const more = (offset + 1) * perPage < items.length;
    return Response.json({
      results,
      next_cursor: `${perPage}:${offset + 1}:0`,
      next_page_results: more,
      total_results: items.length,
    });
  };

  const server = base((request, body: any, route) => {
    // Plane refuses requests without a User-Agent.
    if (!request.headers.get("user-agent")) return Response.json({ detail: "forbidden" }, { status: 403 });
    if (!request.headers.get("x-api-key")) return Response.json({ detail: "auth" }, { status: 401 });
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith("/"))
      return new Response("not found", { status: 404 });
    const path = url.pathname.slice(prefix.length);
    let match: RegExpMatchArray | null;
    if (path === "/states/") return page(PLANE_STATES, url);
    if (path === "/labels/") {
      if (route.startsWith("GET"))
        return page(
          [...labels].map(([id, name]) => ({ id, name })),
          url,
        );
      const id = `pl-${labels.size + 1}`;
      labels.set(id, body.name);
      return Response.json({ id, name: body.name }, { status: 201 });
    }
    if (path === "/work-items/") {
      if (route.startsWith("GET")) {
        const ordered = url.searchParams.get("order_by") === "-created_at" ? [...issues].reverse() : issues;
        return page(ordered.map(item), url);
      }
      const issue: SaasIssue = {
        key: `wi-${issues.length + 1}`,
        title: body.name,
        description: body.description_html,
        labels: body.labels,
        stateKind: "backlog",
        comments: [],
      };
      issues.push(issue);
      return Response.json(item(issue), { status: 201 });
    }
    match = path.match(/^\/work-items\/([\w-]+)\/comments\/$/);
    if (match) {
      const issue = find(match[1] as string);
      if (!issue) return new Response("not found", { status: 404 });
      if (route.startsWith("POST")) {
        issue.comments.push(body.comment_html);
        return Response.json({ id: "c" }, { status: 201 });
      }
      return page(
        issue.comments.map((comment_html) => ({ comment_html })),
        url,
      );
    }
    match = path.match(/^\/work-items\/([\w-]+)\/$/);
    if (match) {
      const issue = find(match[1] as string);
      if (!issue) return Response.json({ detail: "Not found." }, { status: 404 });
      if (route.startsWith("PATCH")) {
        const state = PLANE_STATES.find((candidate) => candidate.id === body.state);
        if (!state) return new Response("bad state", { status: 400 });
        issue.stateKind = state.group;
      }
      return Response.json(item(issue));
    }
    return new Response(`no route ${route}`, { status: 404 });
  });
  return {
    ...server,
    issues,
    labels,
    descriptionText: (issue) => htmlToText(String(issue.description)),
    commentText: (comment) => htmlToText(String(comment)),
  };
}
