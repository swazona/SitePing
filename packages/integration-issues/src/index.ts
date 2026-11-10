/**
 * Issue tracker integration for SitePing. Build hooks with
 * `createIssueTrackerHooks` and pick a provider entry:
 *
 * - `@siteping/integration-issues/github` — GitHub Issues (github.com / Enterprise Server)
 * - `@siteping/integration-issues/gitlab` — GitLab Issues (gitlab.com / self-managed)
 * - `@siteping/integration-issues/linear` — Linear (GraphQL API)
 * - `@siteping/integration-issues/jira` — Jira Cloud (REST API v3)
 * - `@siteping/integration-issues/plane` — Plane (REST API v1, Cloud / self-hosted)
 *
 * Each entry but GitLab's also builds a webhook handler syncing issue
 * states back to the feedback (`create…WebhookHandler`).
 *
 * Or implement `IssueTracker` for any other tracker.
 */
export { createIssueTrackerHooks, type IssueTrackerHooks, type IssueTrackerHooksOptions } from "./core/hooks.js";
export {
  IssueTrackerRequestError,
  isIssueTrackerRequestError,
  isUnlabelledIssueError,
  UnlabelledIssueError,
} from "./core/http-client.js";
export type { IssueContent, IssueFormatOptions } from "./core/issue-format.js";
export { formatIssue } from "./core/issue-format.js";
export type {
  IssueDraft,
  IssueListing,
  IssueReference,
  IssueTracker,
  ReadableIssueTracker,
  TrackedIssue,
} from "./core/issue-tracker.js";
export type { IssueStatusSync, IssueWebhookOptions, IssueWebhookStore } from "./core/webhook.js";
