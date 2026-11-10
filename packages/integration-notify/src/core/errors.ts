import { hasOwn } from "@siteping/core";

const DELIVERY_FAILED_CODE = "NOTIFICATION_DELIVERY_FAILED";

/** Longest outlet answer kept on an error, in characters. */
const DETAIL_MAX_LENGTH = 300;

export interface NotificationDeliveryErrorOptions {
  /** HTTP status the outlet answered, `null` when it gave none (network failure, timeout). */
  status?: number | null | undefined;
  /** Whether another attempt may succeed. Defaults to `true`. */
  retryable?: boolean | undefined;
  /** How long the outlet asked to wait before retrying (`Retry-After`, Telegram's `retry_after`), in ms. */
  retryAfterMs?: number | undefined;
  /** What the outlet said (its error description), cut to 300 characters. Never a URL or a token. */
  detail?: string | undefined;
}

/**
 * A channel could not deliver. Carries what is needed to debug it — the
 * channel, the status, the outlet's own description — never the
 * destination URL or a token: the built-in channels build it without them,
 * and drop the network error itself, which may name the URL. Match it with
 * {@link isNotificationDeliveryError} rather than `instanceof` (each
 * CommonJS entry bundles its own copy of the class).
 */
export class NotificationDeliveryError extends Error {
  readonly code = DELIVERY_FAILED_CODE;
  readonly channel: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly detail: string | undefined;

  constructor(channel: string, message: string, options: NotificationDeliveryErrorOptions = {}) {
    super(`[siteping] ${channel}: ${message}`);
    this.name = "NotificationDeliveryError";
    this.channel = channel;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail === undefined ? undefined : options.detail.slice(0, DETAIL_MAX_LENGTH);
  }
}

/** Whether `error` is a {@link NotificationDeliveryError}, matched on its stable `code`. */
export function isNotificationDeliveryError(error: unknown): error is NotificationDeliveryError {
  return hasOwn(error, "code") && error.code === DELIVERY_FAILED_CODE;
}
