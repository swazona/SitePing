/** Jira Cloud REST API v3, below the site URL. */
export const JIRA_API_PATH = "/rest/api/3";

/** Issue type of new issues, unless `issueType` says otherwise. */
export const JIRA_DEFAULT_ISSUE_TYPE = "Task";

/** Page size when listing issues or comments (the search's maximum). */
export const JIRA_PAGE_SIZE = 100;

/** Status categories (`statusCategory.key`) Jira groups every status in. */
export const JIRA_STATUS_CATEGORY = {
  toDo: "new",
  inProgress: "indeterminate",
  done: "done",
} as const satisfies Record<string, string>;

/**
 * Longest description sent, in characters of Markdown: Jira refuses a
 * description over 32,767 characters, and ADF adds a little.
 */
export const JIRA_DESCRIPTION_MAX_LENGTH = 30_000;

/** Ends a description cut to `JIRA_DESCRIPTION_MAX_LENGTH`. */
export const JIRA_TRUNCATED_NOTE = "_The rest of this feedback is too long for a Jira description._";

/**
 * Resolutions (and transition names) read as "won't fix": Jira's defaults
 * are "Won't Do", "Won't Fix", "Duplicate", "Cannot Reproduce" and "Declined".
 */
export const JIRA_WONT_FIX_PATTERN = /won['’]?t|duplicate|cannot reproduce|declined|not a bug|rejected/i;

/** Header of the HMAC signature of admin webhooks with a secret, as `sha256=<hex>` (WebSub). */
export const JIRA_SIGNATURE_HEADER = "x-hub-signature";
