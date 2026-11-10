import { MemoryStore } from "@siteping/adapter-memory";
import { isSitepingConfigError } from "@siteping/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryRateLimitStore,
  createSitepingHandler,
  type SitepingRateLimitOptions,
  type SitepingRateLimitStore,
} from "../src/index.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "a-secret-key";
const ORIGIN = "https://acme.test";

let clientIds = 0;

function post(ip: string | null, headers: Record<string, string> = {}): Request {
  clientIds += 1;
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}), ...headers },
    body: JSON.stringify({ ...validPayloadNoAnnotations, clientId: `rate-${clientIds}` }),
  });
}

function list(ip: string): Request {
  return new Request(`${ENDPOINT}?projectName=${validPayloadNoAnnotations.projectName}`, {
    headers: { "X-Forwarded-For": ip, Authorization: `Bearer ${API_KEY}` },
  });
}

function handlerWith(rateLimit: SitepingRateLimitOptions, logger = { error: vi.fn() }) {
  return createSitepingHandler({
    store: new MemoryStore(),
    apiKey: API_KEY,
    rateLimit,
    logger,
    allowedOrigins: [ORIGIN],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("is off by default: nothing is counted or refused", async () => {
    const handler = createSitepingHandler({ store: new MemoryStore(), apiKey: API_KEY });
    for (let i = 0; i < 30; i++) expect((await handler.POST(post("1.2.3.4"))).status).toBe(201);
  });

  it("answers 429 with Retry-After past the create limit, per client IP", async () => {
    vi.useFakeTimers({ now: 60_000 * 100 + 15_000, toFake: ["Date"] });
    const handler = handlerWith({ ipHeader: "x-forwarded-for", create: { limit: 2, windowMs: 60_000 } });

    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    const refused = await handler.POST(post("1.1.1.1", { Origin: ORIGIN }));

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("45");
    expect(await refused.json()).toEqual({ error: "Too many requests" });
    // The widget's origin can read the status, and the header.
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(refused.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    // Another client has its own count.
    expect((await handler.POST(post("2.2.2.2"))).status).toBe(201);
  });

  it("starts a fresh count in the next fixed window", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const handler = handlerWith({ ipHeader: "x-forwarded-for", create: { limit: 1, windowMs: 1_000 } });

    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(429);
    vi.setSystemTime(1_000);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
  });

  it("keeps separate limits for create and for the other methods", async () => {
    const handler = handlerWith({
      ipHeader: "x-forwarded-for",
      create: { limit: 1, windowMs: 60_000 },
      other: { limit: 3, windowMs: 60_000 },
    });

    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await handler.GET(list("1.1.1.1"))).status).toBe(200);
    expect((await handler.GET(list("1.1.1.1"))).status).toBe(429);
    // PATCH and DELETE share the `other` count, refused before the body is read.
    const patch = new Request(ENDPOINT, { method: "PATCH", headers: { "X-Forwarded-For": "1.1.1.1" }, body: "{" });
    expect((await handler.PATCH(patch)).status).toBe(429);
  });

  it("leaves a bucket without a rule unlimited, and never limits OPTIONS", async () => {
    const handler = handlerWith({ ipHeader: "x-forwarded-for", other: { limit: 1, windowMs: 60_000 } });

    for (let i = 0; i < 5; i++) expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    const preflight = new Request(ENDPOINT, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    for (let i = 0; i < 5; i++) expect(handler.OPTIONS(preflight).status).toBe(204);
  });

  it("reads only the last entry of the IP header, which the closest proxy appended", async () => {
    const handler = handlerWith({ ipHeader: "x-forwarded-for", create: { limit: 1, windowMs: 60_000 } });

    expect((await handler.POST(post("forged-1, 9.9.9.9"))).status).toBe(201);
    // A client rotating what it prepends still lands on its real address.
    expect((await handler.POST(post("forged-2, 9.9.9.9"))).status).toBe(429);
  });

  it("lets a request without the header through", async () => {
    const handler = handlerWith({ ipHeader: "x-forwarded-for", create: { limit: 1, windowMs: 60_000 } });

    for (let i = 0; i < 3; i++) expect((await handler.POST(post(null))).status).toBe(201);
  });

  it("counts under the key function's answer, and not at all on null", async () => {
    const key = vi.fn((request: Request) => request.headers.get("X-Session"));
    const handler = handlerWith({ key, create: { limit: 1, windowMs: 60_000 } });

    expect((await handler.POST(post("1.1.1.1", { "X-Session": "a" }))).status).toBe(201);
    expect((await handler.POST(post("2.2.2.2", { "X-Session": "a" }))).status).toBe(429);
    expect((await handler.POST(post("1.1.1.1", { "X-Session": "b" }))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect(key).toHaveBeenCalledWith(expect.any(Request), "create");
  });

  it("smooths the window boundary with the sliding algorithm", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const create = { limit: 4, windowMs: 1_000 };
    const fixed = handlerWith({ ipHeader: "x-forwarded-for", create });
    const sliding = handlerWith({ ipHeader: "x-forwarded-for", create: { ...create, algorithm: "sliding" } });

    vi.setSystemTime(900);
    for (let i = 0; i < 4; i++) {
      expect((await fixed.POST(post("1.1.1.1"))).status).toBe(201);
      expect((await sliding.POST(post("1.1.1.1"))).status).toBe(201);
    }
    // 100 ms later, in the next window: the fixed one allows another 4 at once.
    vi.setSystemTime(1_000);
    expect((await fixed.POST(post("1.1.1.1"))).status).toBe(201);
    const refused = await sliding.POST(post("1.1.1.1"));
    expect(refused.status).toBe(429);
    // The previous window's 4 hits weigh 4 at the boundary, and the refused
    // request counts: the retry fits once half the previous window slid out.
    expect(refused.headers.get("Retry-After")).toBe("1");
    vi.setSystemTime(1_499);
    expect((await sliding.POST(post("1.1.1.1"))).status).toBe(429);
    vi.setSystemTime(2_000);
    expect((await sliding.POST(post("1.1.1.1"))).status).toBe(201);
  });

  it("uses a shared store through its two calls, and lets requests through when it fails", async () => {
    const memory = createMemoryRateLimitStore();
    const calls: string[] = [];
    let failing = false;
    const store: SitepingRateLimitStore = {
      async increment(key, ttlMs) {
        calls.push(`increment ${key} ${ttlMs}`);
        if (failing) throw new Error("redis down");
        return memory.increment(key, ttlMs);
      },
      async get(key) {
        calls.push(`get ${key}`);
        return memory.get(key);
      },
    };
    const logger = { error: vi.fn() };
    const handler = handlerWith({ ipHeader: "x-forwarded-for", store, create: { limit: 1, windowMs: 60_000 } }, logger);

    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(429);
    expect(calls[0]).toMatch(/^increment siteping:create:1\.1\.1\.1:\d+ 60000$/);

    failing = true;
    expect((await handler.POST(post("1.1.1.1"))).status).toBe(201);
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Rate limiting failed, request let through",
      expect.objectContaining({ method: "POST", path: "/api/siteping" }),
    );
  });

  it("keeps a key holding separators away from another key's counters", async () => {
    const handler = handlerWith({
      key: (request) => request.headers.get("X-Key"),
      create: { limit: 1, windowMs: 60_000 },
    });

    expect((await handler.POST(post(null, { "X-Key": "a:1" }))).status).toBe(201);
    expect((await handler.POST(post(null, { "X-Key": "a" }))).status).toBe(201);
  });

  it("refuses options it cannot run with, when the handler is created", () => {
    const refused: SitepingRateLimitOptions[] = [
      { create: { limit: 1, windowMs: 1_000 } },
      { ipHeader: " ", create: { limit: 1, windowMs: 1_000 } },
      { ipHeader: "x-forwarded-for", create: { limit: 0, windowMs: 1_000 } },
      { ipHeader: "x-forwarded-for", other: { limit: 1, windowMs: Number("1m") } },
      { ipHeader: "x-forwarded-for", other: { limit: 1, windowMs: 1, algorithm: "leaky" as "fixed" } },
    ];
    for (const rateLimit of refused) {
      let thrown: unknown;
      try {
        createSitepingHandler({ store: new MemoryStore(), apiKey: API_KEY, rateLimit });
      } catch (error) {
        thrown = error;
      }
      expect(isSitepingConfigError(thrown) && thrown.code).toBe("CONFIG_RATE_LIMIT_INVALID");
    }
  });
});

describe("createMemoryRateLimitStore", () => {
  it("expires a counter ttlMs after its first increment", () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const store = createMemoryRateLimitStore();

    expect(store.increment("k", 100)).toBe(1);
    vi.setSystemTime(50);
    expect(store.increment("k", 100)).toBe(2);
    expect(store.get("k")).toBe(2);
    vi.setSystemTime(100);
    expect(store.get("k")).toBe(0);
    expect(store.increment("k", 100)).toBe(1);
  });
});
