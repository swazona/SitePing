import {
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationMessage,
} from "./channel.js";
import { isNotificationDeliveryError, NotificationDeliveryError } from "./errors.js";

/** A channel with the notifications it takes: every one by default. */
export interface NotificationRoute {
  channel: NotificationChannel;
  /** Events the channel takes. Defaults to all of them. */
  events?: readonly NotificationEvent[] | undefined;
  /** Projects the channel takes, by `projectName`. Defaults to all of them. */
  projects?: readonly string[] | undefined;
  /** Any other rule, e.g. bugs only, or replies from reporters only. A throw counts as a failed delivery. */
  filter?: ((message: NotificationMessage) => boolean) | undefined;
}

/** Where dispatch failures are reported. */
export interface NotificationLogger {
  error(message: string, context?: Record<string, unknown>): unknown;
}

export interface NotificationDispatcherOptions {
  /** The outlets: a channel takes every notification, a route only those it selects. */
  channels: ReadonlyArray<NotificationChannel | NotificationRoute>;
  /** Retries after a failed attempt, per channel. Defaults to 2 (three attempts); 0 turns them off. */
  retries?: number | undefined;
  /**
   * Wait before the first retry, in ms, doubled on each next one, with
   * jitter (50 to 100 % of it). Defaults to 1000. A `retryAfterMs` the
   * outlet asked for (`Retry-After`, Telegram's `retry_after`) wins.
   */
  retryDelayMs?: number | undefined;
  /** Longest wait between two attempts, in ms — the outlet's own `Retry-After` included. Defaults to 30 000. */
  maxRetryDelayMs?: number | undefined;
  /** Longest attempt, in ms: past it, the attempt fails and its signal aborts. Defaults to 10 000. */
  timeoutMs?: number | undefined;
  /** Defaults to `console`. A logger that throws or rejects is ignored. */
  logger?: NotificationLogger | undefined;
}

/** What became of a notification on one channel. */
export interface NotificationDelivery {
  channel: string;
  /** `skipped`: the route does not take this notification. */
  outcome: "sent" | "skipped" | "failed";
  /** Attempts made, 0 when skipped. */
  attempts: number;
  /** The last failure, when `failed`. */
  error?: unknown;
}

export interface NotificationDispatcher {
  /**
   * Send `message` to every channel that takes it, all at once, each with
   * its own retries and timeout. Never rejects: a failing channel is
   * logged and reported in the result, and never holds back the others.
   */
  dispatch(message: NotificationMessage): Promise<NotificationDelivery[]>;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Longest delay a timer holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_RETRIES = 10;

function checkInteger(name: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw new Error(`[siteping] createNotificationDispatcher: \`${name}\` must be an integer from ${min} to ${max}`);
  }
}

function toRoute(entry: NotificationChannel | NotificationRoute): NotificationRoute {
  const resolved: NotificationRoute = "send" in entry ? { channel: entry } : entry;
  const { channel, events } = resolved;
  if (!channel || typeof channel.name !== "string" || !channel.name || typeof channel.send !== "function") {
    throw new Error("[siteping] createNotificationDispatcher: every channel needs a `name` and a `send` function");
  }
  for (const event of events ?? []) {
    if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) {
      throw new Error(
        `[siteping] createNotificationDispatcher: unknown event "${String(event)}" for channel ${channel.name}`,
      );
    }
  }
  return resolved;
}

/** Only an error's name and message — not its `cause`, which a custom channel may fill with its request. */
function describeError(error: unknown): Record<string, unknown> {
  if (isNotificationDeliveryError(error)) {
    return {
      error: error.message,
      status: error.status,
      retryable: error.retryable,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

/** Report through `logger` without letting it fail its caller. */
export function safeLog(logger: NotificationLogger, message: string, context: Record<string, unknown>): void {
  try {
    Promise.resolve(logger.error(message, context)).catch(() => {});
  } catch {
    // A logger that throws has nowhere else to report to.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fan a notification out to its channels — filters, retries with
 * exponential backoff, a timeout per attempt, and failure isolation: one
 * channel failing (or hanging) never blocks the others, and nothing throws.
 *
 * @throws Error at creation, for a channel without a `name` or `send`, an
 * unknown event in a route, or an out-of-range number.
 */
export function createNotificationDispatcher(options: NotificationDispatcherOptions): NotificationDispatcher {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = console,
  } = options;
  checkInteger("retries", retries, 0, MAX_RETRIES);
  checkInteger("retryDelayMs", retryDelayMs, 0, MAX_TIMER_MS);
  checkInteger("maxRetryDelayMs", maxRetryDelayMs, 0, MAX_TIMER_MS);
  checkInteger("timeoutMs", timeoutMs, 1, MAX_TIMER_MS);
  if (!Array.isArray(options.channels)) {
    throw new Error("[siteping] createNotificationDispatcher: `channels` must be an array");
  }
  const routes = options.channels.map(toRoute);

  const takes = (route: NotificationRoute, message: NotificationMessage): boolean =>
    (route.events === undefined || route.events.includes(message.event)) &&
    (route.projects === undefined || route.projects.includes(message.projectName)) &&
    (route.filter === undefined || route.filter(message));

  /** One attempt, failed past `timeoutMs` whether the channel honours its signal or not. */
  const attempt = async (channel: NotificationChannel, message: NotificationMessage, n: number): Promise<void> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new NotificationDeliveryError(channel.name, `timed out after ${timeoutMs} ms`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      // `.then` so a channel that throws synchronously fails its attempt, not the dispatch.
      const sending = Promise.resolve().then(() => channel.send(message, { signal: controller.signal, attempt: n }));
      // Abandoned past the timeout: its late failure must not go unhandled.
      sending.catch(() => {});
      await Promise.race([sending, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const delayBefore = (retry: number, error: unknown): number => {
    const asked = isNotificationDeliveryError(error) ? error.retryAfterMs : undefined;
    if (asked !== undefined) return Math.min(asked, maxRetryDelayMs);
    const backoff = retryDelayMs * 2 ** (retry - 1);
    return Math.min(backoff * (0.5 + Math.random() / 2), maxRetryDelayMs);
  };

  const deliver = async (route: NotificationRoute, message: NotificationMessage): Promise<NotificationDelivery> => {
    const { channel } = route;
    const subject = {
      channel: channel.name,
      event: message.event,
      feedbackId: message.feedbackId,
      projectName: message.projectName,
    };
    let attempts = 0;
    let lastError: unknown;
    try {
      if (!takes(route, message)) return { channel: channel.name, outcome: "skipped", attempts };
      for (;;) {
        attempts++;
        try {
          await attempt(channel, message, attempts);
          return { channel: channel.name, outcome: "sent", attempts };
        } catch (error) {
          lastError = error;
          const retryable = !isNotificationDeliveryError(error) || error.retryable;
          if (!retryable || attempts > retries) break;
          await sleep(delayBefore(attempts, error));
        }
      }
    } catch (error) {
      // The route's filter threw.
      lastError = error;
    }
    safeLog(logger, `[siteping] Notification to ${channel.name} failed`, {
      ...subject,
      attempts,
      ...describeError(lastError),
    });
    return { channel: channel.name, outcome: "failed", attempts, error: lastError };
  };

  return {
    dispatch: (message) => Promise.all(routes.map((route) => deliver(route, message))),
  };
}
