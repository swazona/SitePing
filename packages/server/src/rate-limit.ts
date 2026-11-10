import { SitepingConfigError, type SitepingLogger } from "@siteping/core";
import { ERROR_MESSAGES, MEMORY_RATE_LIMIT_SWEEP_EVERY } from "./constants.js";
import { buildCorsHeaders, withCors } from "./cors.js";
import type { SitepingHttpMethod } from "./options.js";

/**
 * Which limit a request counts against: `create` for `POST` (a feedback or a
 * reply, what anonymous visitors send), `other` for `GET`, `PATCH` and
 * `DELETE`. `OPTIONS` preflights are never limited.
 */
export type SitepingRateLimitBucket = "create" | "other";

/**
 * One limit: at most `limit` requests per `windowMs` for each key.
 *
 * - `fixed` (default) counts requests in consecutive windows aligned on
 *   `windowMs`. Cheapest, but a client may send up to twice `limit` across
 *   the boundary between two windows.
 * - `sliding` weighs the previous window's count by how much of it still
 *   overlaps the last `windowMs` (the sliding window counter
 *   approximation), which smooths that boundary out for one extra read.
 */
export interface SitepingRateLimitRule {
  limit: number;
  windowMs: number;
  algorithm?: "fixed" | "sliding" | undefined;
}

/**
 * Where the counters live. The built-in store keeps them in this process's
 * memory, which is enough for one long-running server. Several instances
 * (serverless functions, a cluster) each count on their own, so a client
 * gets `limit` per instance: give them a shared store — two calls over
 * Redis (`INCR` + `PEXPIRE`, `GET`), Upstash, a KV or a database row.
 *
 * Counter keys are opaque strings, each used for one window only.
 */
export interface SitepingRateLimitStore {
  /**
   * Add one to the counter `key` and return its new value. A counter that
   * does not exist starts at 0 and must expire `ttlMs` after it was created
   * (a later increment does not extend it).
   */
  increment(key: string, ttlMs: number): number | Promise<number>;
  /** Current value of the counter `key`: 0 when it does not exist or expired. */
  get(key: string): number | Promise<number>;
}

/**
 * Opt-in rate limiting for `createSitepingHandler`. Leave a bucket out to
 * leave its methods unlimited.
 */
export interface SitepingRateLimitOptions {
  /** Limit of `POST` — feedback submissions and replies. */
  create?: SitepingRateLimitRule | undefined;
  /** Limit of `GET`, `PATCH` and `DELETE`. */
  other?: SitepingRateLimitRule | undefined;
  /**
   * Request header carrying the client's IP, set by the proxy in front of
   * the server: `x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`,
   * `fly-client-ip`… Only the last comma-separated entry is read: the one
   * the closest proxy appended, which a client cannot forge (the entries
   * before it can be). Behind more than one proxy that appends, use `key`.
   *
   * Never name a header no proxy of yours sets or overwrites: the client
   * would then choose its own key, and get a fresh limit with each one.
   */
  ipHeader?: string | undefined;
  /**
   * Key a request is counted under, in place of `ipHeader`: a session id,
   * an API token's id, an IP your platform hands over. Return `null` or
   * `undefined` to leave a request unlimited. A throw is logged and the
   * request goes through.
   */
  key?:
    | ((
        request: Request,
        bucket: SitepingRateLimitBucket,
      ) => string | null | undefined | Promise<string | null | undefined>)
    | undefined;
  /** Where counters live. Defaults to this process's memory — see `SitepingRateLimitStore`. */
  store?: SitepingRateLimitStore | undefined;
}

/** What counting a request decided. */
type Verdict = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Counters in this process's memory, swept of expired ones as they are used. */
export function createMemoryRateLimitStore(): SitepingRateLimitStore {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  let calls = 0;
  const live = (key: string, now: number) => {
    const counter = counters.get(key);
    if (counter && counter.expiresAt <= now) {
      counters.delete(key);
      return undefined;
    }
    return counter;
  };
  return {
    increment(key, ttlMs) {
      const now = Date.now();
      if (++calls % MEMORY_RATE_LIMIT_SWEEP_EVERY === 0) {
        for (const [counterKey, counter] of counters) if (counter.expiresAt <= now) counters.delete(counterKey);
      }
      const counter = live(key, now) ?? { count: 0, expiresAt: now + ttlMs };
      counter.count += 1;
      counters.set(key, counter);
      return counter.count;
    },
    get(key) {
      return live(key, Date.now())?.count ?? 0;
    },
  };
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function checkRule(name: SitepingRateLimitBucket, rule: SitepingRateLimitRule | undefined): void {
  if (rule === undefined) return;
  if (!isPositiveInteger(rule.limit) || !isPositiveInteger(rule.windowMs)) {
    throw new SitepingConfigError(
      "CONFIG_RATE_LIMIT_INVALID",
      `[siteping] createSitepingHandler: \`rateLimit.${name}\` needs a positive integer \`limit\` and \`windowMs\`.`,
    );
  }
  if (rule.algorithm !== undefined && rule.algorithm !== "fixed" && rule.algorithm !== "sliding") {
    throw new SitepingConfigError(
      "CONFIG_RATE_LIMIT_INVALID",
      `[siteping] createSitepingHandler: \`rateLimit.${name}.algorithm\` must be "fixed" or "sliding".`,
    );
  }
}

/** The client key of `request` from `header`: its last comma-separated entry, trimmed. */
function keyFromHeader(request: Request, header: string): string | null {
  const value = request.headers.get(header);
  if (!value) return null;
  const last = value.split(",").at(-1)?.trim();
  return last || null;
}

/** Count one request of `key` against `rule`, in the window `now` falls in. */
async function count(
  store: SitepingRateLimitStore,
  counterPrefix: string,
  rule: SitepingRateLimitRule,
  now: number,
): Promise<Verdict> {
  const { limit, windowMs } = rule;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const elapsed = now - windowStart;
  const windowEnd = windowStart + windowMs - now;
  if (rule.algorithm !== "sliding") {
    const current = await store.increment(`${counterPrefix}:${windowStart}`, windowMs);
    return current <= limit ? { allowed: true } : { allowed: false, retryAfterMs: windowEnd };
  }
  // The previous window must outlive the current one: kept for two windows.
  const [current, previous] = await Promise.all([
    store.increment(`${counterPrefix}:${windowStart}`, 2 * windowMs),
    store.get(`${counterPrefix}:${windowStart - windowMs}`),
  ]);
  const overlap = 1 - elapsed / windowMs;
  if (previous * overlap + current <= limit) return { allowed: true };
  // A rejected request counted too, and the retry will count once more.
  // Past the limit within this window alone: room comes back once enough of
  // it has slid out of the last windowMs, in the next window.
  if (current >= limit) {
    return { allowed: false, retryAfterMs: windowEnd + Math.ceil(windowMs * (1 - (limit - 1) / current)) };
  }
  // Otherwise once enough of the previous window has slid out.
  const freedAt = windowMs * (1 - (limit - current - 1) / previous);
  return { allowed: false, retryAfterMs: Math.max(1, Math.ceil(freedAt - elapsed)) };
}

/** Wraps a method's handler with the limit of its bucket. */
export type RateLimiter = (
  method: Exclude<SitepingHttpMethod, "OPTIONS">,
  handle: (request: Request) => Promise<Response>,
) => (request: Request) => Promise<Response>;

/**
 * The rate limiter of `options`, or one that wraps nothing without them.
 * Checked once, when the handler is created.
 */
export function createRateLimiter(
  options: SitepingRateLimitOptions | undefined,
  allowedOrigins: ReadonlyArray<string> | undefined,
  logger: Pick<SitepingLogger, "error">,
): RateLimiter {
  if (!options) return (_method, handle) => handle;
  checkRule("create", options.create);
  checkRule("other", options.other);
  const { ipHeader, key } = options;
  if (!key && (typeof ipHeader !== "string" || ipHeader.trim() === "")) {
    throw new SitepingConfigError(
      "CONFIG_RATE_LIMIT_INVALID",
      "[siteping] createSitepingHandler: `rateLimit` needs `ipHeader` (the header your proxy sets with the client IP, " +
        'e.g. "x-forwarded-for") or a `key` function.',
    );
  }
  const store = options.store ?? createMemoryRateLimitStore();

  const keyOf = async (request: Request, bucket: SitepingRateLimitBucket): Promise<string | null> =>
    key ? ((await key(request, bucket)) ?? null) : keyFromHeader(request, ipHeader as string);

  return (method, handle) => {
    const bucket: SitepingRateLimitBucket = method === "POST" ? "create" : "other";
    const rule = options[bucket];
    if (!rule) return handle;
    return async (request) => {
      let verdict: Verdict = { allowed: true };
      try {
        const client = await keyOf(request, bucket);
        // Encoded so a key holding `:` cannot reach another key's counters.
        if (client) verdict = await count(store, `siteping:${bucket}:${encodeURIComponent(client)}`, rule, Date.now());
      } catch (error) {
        // A limiter that fails lets the request through: an outage of the
        // counters' store must not take the feedback API down with it.
        logger.error("[siteping] Rate limiting failed, request let through", {
          error,
          method: request.method,
          path: new URL(request.url).pathname,
        });
      }
      if (verdict.allowed) return handle(request);
      const corsHeaders = buildCorsHeaders(request, allowedOrigins);
      const response = Response.json(
        { error: ERROR_MESSAGES.tooManyRequests },
        { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) } },
      );
      // A cross-origin script reads only safelisted response headers unless told otherwise.
      if (corsHeaders["Access-Control-Allow-Origin"])
        response.headers.set("Access-Control-Expose-Headers", "Retry-After");
      return withCors(response, corsHeaders);
    };
  };
}
