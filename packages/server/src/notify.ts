import type { FeedbackRecord } from "@siteping/core";
import type { SitepingHandlerBaseOptions, SitepingTeamEvent } from "./options.js";
import type { Pipeline, Scope } from "./pipeline.js";
import {
  deliverySubject,
  dispatchDelivery,
  subscribesTo,
  type WebhookConfig,
  type WebhookDelivery,
} from "./webhooks.js";

/**
 * Notify the webhooks subscribed to `delivery`'s event, once its write has
 * succeeded. Fire-and-forget: never awaited, so the client isn't held back on
 * slow Slack/Discord/generic receivers, and never throws — the delivery traps
 * its own errors and reports them through `WebhookConfig.onError`.
 */
export type Notify<Principal> = (scope: Scope<Principal>, delivery: WebhookDelivery) => void;

export function createNotifier<Principal>(
  webhooks: ReadonlyArray<WebhookConfig>,
  waitUntil: SitepingHandlerBaseOptions<Principal>["waitUntil"],
  pipeline: Pipeline<Principal>,
): Notify<Principal> {
  return (scope, delivery) => {
    // No subscriber, no work handed to the runtime.
    if (!webhooks.some((config) => subscribesTo(config, delivery.event))) return;
    const pending = dispatchDelivery(webhooks, delivery);
    try {
      waitUntil?.(pending);
    } catch (error) {
      const { feedbackId, projectName } = deliverySubject(delivery);
      pipeline.logError(scope, "[siteping] waitUntil failed", {
        error,
        event: delivery.event,
        ...(feedbackId ? { feedbackId } : {}),
        projectName,
      });
    }
  };
}

/**
 * Tell the team about `event` through `notifyTeam`, without holding the
 * request: the call runs in the background (its feedback looked up there
 * when it is a function), its promise goes to `waitUntil`, and a throw or a
 * rejection is logged as a failed hook.
 */
export type NotifyTeam<Principal> = (
  scope: Scope<Principal>,
  subject: { feedbackId: string; projectName: string; commentId?: string },
  feedback: FeedbackRecord | (() => Promise<FeedbackRecord | null>),
  event: SitepingTeamEvent,
) => void;

/** `undefined` without a `notifyTeam`, so operations skip the work (and the status read) altogether. */
export function createTeamNotifier<Principal>(
  notifyTeam: SitepingHandlerBaseOptions<Principal>["notifyTeam"],
  waitUntil: SitepingHandlerBaseOptions<Principal>["waitUntil"],
  pipeline: Pipeline<Principal>,
): NotifyTeam<Principal> | undefined {
  if (!notifyTeam) return undefined;
  return (scope, subject, feedback, event) => {
    const logged = { ...subject, event: event.type };
    // `runHook` traps and logs every failure, so `pending` never rejects.
    const pending = pipeline.runHook(scope, "notifyTeam", logged, async () => {
      const record = typeof feedback === "function" ? await feedback() : feedback;
      if (!record) throw new Error(`[siteping] notifyTeam: feedback ${subject.feedbackId} not found to notify`);
      await notifyTeam(record, event, scope.context);
    });
    try {
      waitUntil?.(pending);
    } catch (error) {
      pipeline.logError(scope, "[siteping] waitUntil failed", { error, ...logged });
    }
  };
}
