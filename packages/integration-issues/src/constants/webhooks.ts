/** Default `maxBodyBytes` of the tracker webhooks: issue payloads run to tens of kilobytes, Jira's above. */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** How long after it was sent a Linear delivery is accepted, as Linear recommends (`webhookTimestamp`). */
export const LINEAR_WEBHOOK_TOLERANCE_MS = 60_000;

/** `error` and `reason` strings of the webhook responses. Informational: trackers only read the status. */
export const WEBHOOK_RESPONSES = {
  methodNotAllowed: "Method not allowed",
  bodyTooLarge: "Request body too large",
  invalidSignature: "Invalid signature",
  invalidJson: "Invalid JSON",
  failed: "Webhook processing failed",
  notAStateChange: "not an issue state change",
  notLinked: "issue is not linked to a feedback",
  otherInstance: "issue belongs to another instance",
  feedbackNotFound: "feedback not found",
  alreadyInSync: "feedback status already matches",
} as const satisfies Record<string, string>;
