/** Plane Cloud's API root; override `apiBaseUrl` for a self-hosted instance. */
export const PLANE_API_BASE_URL = "https://api.plane.so";

/** Plane Cloud's web app, where issue links point. */
export const PLANE_APP_BASE_URL = "https://app.plane.so";

/** Page size when listing work items or comments (Plane's maximum). */
export const PLANE_PAGE_SIZE = 100;

/** State groups, as Plane names them. */
export const PLANE_STATE_GROUP = {
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  cancelled: "cancelled",
} as const satisfies Record<string, string>;

/** Plane refuses requests without a User-Agent (403), which not every runtime's fetch sets. */
export const PLANE_USER_AGENT = "siteping-integration-issues";

/** Header carrying the hex HMAC-SHA256 of a webhook delivery's raw body. */
export const PLANE_SIGNATURE_HEADER = "x-plane-signature";
