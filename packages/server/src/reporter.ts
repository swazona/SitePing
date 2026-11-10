import { type FeedbackRecord, type FeedbackStatus, isClosedStatus, type SitepingStore } from "@siteping/core";
import { REPORTER_LOOKUP_MAX_PAGES, REPORTER_LOOKUP_PAGE_SIZE } from "./constants.js";
import type { SitepingReporterEvent } from "./options.js";

/**
 * The reporter event a status change makes, or `null` when it tells the
 * reporter nothing. `previous` is the status before the change, when the
 * store could read it (`getFeedback`): a change then notifies only when it
 * crosses between open and closed, or changes the close reason. Without it,
 * every PATCH to a closed status counts as resolved and every PATCH to
 * `open` as reopened — the store keeps no previous status to compare with.
 */
export function statusEvent(status: FeedbackStatus, previous: FeedbackStatus | null): SitepingReporterEvent | null {
  if (previous === status) return null;
  if (isClosedStatus(status)) return { type: "resolved", status };
  if (previous === null) return status === "open" ? { type: "reopened", status } : null;
  return isClosedStatus(previous) ? { type: "reopened", status } : null;
}

/**
 * The feedback a reply belongs to: through `getFeedback` when the store has
 * it, else by listing the project's newest feedbacks, up to
 * `REPORTER_LOOKUP_MAX_PAGES` pages. `null` when neither finds it.
 */
export async function findFeedback(
  store: SitepingStore,
  feedbackId: string,
  projectName: string,
): Promise<FeedbackRecord | null> {
  if (store.getFeedback) return store.getFeedback(feedbackId);
  for (let page = 1; page <= REPORTER_LOOKUP_MAX_PAGES; page++) {
    const { feedbacks, total } = await store.getFeedbacks({ projectName, page, limit: REPORTER_LOOKUP_PAGE_SIZE });
    const found = feedbacks.find((feedback) => feedback.id === feedbackId);
    if (found) return found;
    if (page * REPORTER_LOOKUP_PAGE_SIZE >= total || feedbacks.length === 0) return null;
  }
  return null;
}
