/** ClickUp's public API root; the v2 endpoints are below `/api/v2`. */
export const CLICKUP_API_BASE_URL = "https://api.clickup.com";

/** Path of the v2 API below the root. */
export const CLICKUP_API_PATH = "/api/v2";

/** Tasks a list endpoint answers per page (ClickUp's fixed size). */
export const CLICKUP_TASK_PAGE_SIZE = 100;

/** Comments the task comments endpoint answers per page, newest first. */
export const CLICKUP_COMMENT_PAGE_SIZE = 25;

/**
 * Status `type`s, as ClickUp names them: every list has one `open` status
 * (the first) and one `closed` status (the last), `custom` ones in between,
 * and may have `done` ones, which also count as finished.
 */
export const CLICKUP_STATUS_TYPE = {
  open: "open",
  custom: "custom",
  done: "done",
  closed: "closed",
} as const satisfies Record<string, string>;

/** Header carrying the hex HMAC-SHA256 of a webhook delivery's raw body, keyed with the webhook's `secret`. */
export const CLICKUP_SIGNATURE_HEADER = "x-signature";

/** The webhook event of a task whose status changed. */
export const CLICKUP_STATUS_EVENT = "taskStatusUpdated";
