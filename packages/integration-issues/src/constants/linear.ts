/** Linear's API root; the GraphQL endpoint is `/graphql` below it. */
export const LINEAR_API_BASE_URL = "https://api.linear.app";

/** Path of the GraphQL endpoint. */
export const LINEAR_GRAPHQL_PATH = "/graphql";

/** Page size when listing issues or comments. */
export const LINEAR_PAGE_SIZE = 100;

/** Workflow state `type`s, as Linear names them. */
export const LINEAR_STATE_TYPE = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  canceled: "canceled",
} as const satisfies Record<string, string>;

/** Header carrying the hex HMAC-SHA256 of a webhook delivery's raw body. */
export const LINEAR_SIGNATURE_HEADER = "linear-signature";
