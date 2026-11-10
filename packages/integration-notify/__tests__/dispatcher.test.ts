import { describe, expect, it, vi } from "vitest";
import {
  createNotificationDispatcher,
  type NotificationChannel,
  NotificationDeliveryError,
  type NotificationMessage,
} from "../src/index.js";
import { message } from "./fixtures.js";

function channel(name: string, send: NotificationChannel["send"] = async () => {}) {
  const spy = vi.fn(send);
  return { channel: { name, send: spy } satisfies NotificationChannel, spy };
}

const quiet = () => ({ error: vi.fn() });

describe("createNotificationDispatcher", () => {
  it("fans a message out to every channel", async () => {
    const a = channel("a");
    const b = channel("b");
    const dispatcher = createNotificationDispatcher({ channels: [a.channel, b.channel], logger: quiet() });

    const deliveries = await dispatcher.dispatch(message());

    expect(deliveries).toEqual([
      { channel: "a", outcome: "sent", attempts: 1 },
      { channel: "b", outcome: "sent", attempts: 1 },
    ]);
    expect(a.spy).toHaveBeenCalledWith(
      message(),
      expect.objectContaining({ attempt: 1, signal: expect.any(AbortSignal) }),
    );
  });

  it("filters per channel by event, project and predicate", async () => {
    const replies = channel("replies");
    const other = channel("other-project");
    const bugs = channel("bugs");
    const dispatcher = createNotificationDispatcher({
      logger: quiet(),
      channels: [
        { channel: replies.channel, events: ["replied"] },
        { channel: other.channel, projects: ["other"] },
        { channel: bugs.channel, filter: (m: NotificationMessage) => m.feedbackType === "bug" },
      ],
    });

    const deliveries = await dispatcher.dispatch(message());

    expect(deliveries.map((delivery) => delivery.outcome)).toEqual(["skipped", "skipped", "sent"]);
    expect(replies.spy).not.toHaveBeenCalled();
    expect(other.spy).not.toHaveBeenCalled();
  });

  it("retries a failing channel with backoff, then succeeds", async () => {
    let calls = 0;
    const flaky = channel("flaky", async () => {
      if (++calls < 3) throw new Error("ECONNRESET");
    });
    const dispatcher = createNotificationDispatcher({ channels: [flaky.channel], retryDelayMs: 1, logger: quiet() });

    expect(await dispatcher.dispatch(message())).toEqual([{ channel: "flaky", outcome: "sent", attempts: 3 }]);
    expect(flaky.spy.mock.calls.map(([, context]) => context.attempt)).toEqual([1, 2, 3]);
  });

  it("doubles the wait between attempts and honours an outlet's retryAfterMs, capped", async () => {
    vi.useFakeTimers();
    try {
      const times: number[] = [];
      const limited = channel("limited", async () => {
        times.push(Date.now());
        throw new NotificationDeliveryError("limited", "429", { status: 429, retryAfterMs: 60_000 });
      });
      const plain = channel("plain", async () => {
        times.push(Date.now());
        throw new Error("down");
      });
      vi.spyOn(Math, "random").mockReturnValue(1); // jitter at its top: the full delay
      const dispatcher = createNotificationDispatcher({
        channels: [limited.channel],
        retries: 1,
        maxRetryDelayMs: 5000,
        logger: quiet(),
      });
      const pending = dispatcher.dispatch(message());
      await vi.runAllTimersAsync();
      await pending;
      expect(times[1]! - times[0]!).toBe(5000); // asked 60 s, capped at 5 s

      times.length = 0;
      const backoff = createNotificationDispatcher({
        channels: [plain.channel],
        retries: 3,
        retryDelayMs: 100,
        logger: quiet(),
      });
      const second = backoff.dispatch(message());
      await vi.runAllTimersAsync();
      await second;
      expect(times.slice(1).map((time, i) => time - times[i]!)).toEqual([100, 200, 400]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("never retries a failure marked not retryable", async () => {
    const revoked = channel("revoked", async () => {
      throw new NotificationDeliveryError("revoked", "request failed with status 401", {
        status: 401,
        retryable: false,
      });
    });
    const logger = quiet();
    const dispatcher = createNotificationDispatcher({ channels: [revoked.channel], retryDelayMs: 0, logger });

    const [delivery] = await dispatcher.dispatch(message());

    expect(delivery).toMatchObject({ channel: "revoked", outcome: "failed", attempts: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      "[siteping] Notification to revoked failed",
      expect.objectContaining({
        channel: "revoked",
        event: "created",
        feedbackId: "fb_1",
        status: 401,
        retryable: false,
      }),
    );
  });

  it("isolates failures: a throwing, a synchronously throwing and a hanging channel never stop the others", async () => {
    const failing = channel("failing", async () => {
      throw new Error("boom");
    });
    const sync = {
      name: "sync",
      send: (() => {
        throw new Error("sync boom");
      }) as NotificationChannel["send"],
    };
    let aborted = false;
    const hanging = channel(
      "hanging",
      (_message, { signal }) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const healthy = channel("healthy");
    const filterThrows = channel("filter");
    const logger = quiet();
    const dispatcher = createNotificationDispatcher({
      channels: [
        failing.channel,
        sync,
        hanging.channel,
        healthy.channel,
        {
          channel: filterThrows.channel,
          filter: () => {
            throw new Error("bad filter");
          },
        },
      ],
      retries: 1,
      retryDelayMs: 0,
      timeoutMs: 20,
      logger,
    });

    const deliveries = await dispatcher.dispatch(message());

    expect(Object.fromEntries(deliveries.map((delivery) => [delivery.channel, delivery.outcome]))).toEqual({
      failing: "failed",
      sync: "failed",
      hanging: "failed",
      healthy: "sent",
      filter: "failed",
    });
    const hung = deliveries.find((delivery) => delivery.channel === "hanging");
    expect(hung?.attempts).toBe(2);
    expect(String(hung?.error)).toContain("timed out after 20 ms");
    expect(aborted).toBe(true);
    expect(filterThrows.spy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(4);
  });

  it("logs only an error's name and message, never its cause, and survives a throwing logger", async () => {
    const leaky = channel("leaky", async () => {
      throw new Error("refused", { cause: { url: "https://hooks.slack.com/services/T000/B000/SECRET" } });
    });
    const logger = { error: vi.fn() };
    const dispatcher = createNotificationDispatcher({ channels: [leaky.channel], retries: 0, logger });
    await dispatcher.dispatch(message());
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("SECRET");
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ error: "Error: refused" });

    const throwing = createNotificationDispatcher({
      channels: [leaky.channel],
      retries: 0,
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
    });
    await expect(throwing.dispatch(message())).resolves.toHaveLength(1);
    const rejecting = createNotificationDispatcher({
      channels: [leaky.channel],
      retries: 0,
      logger: { error: () => Promise.reject(new Error("shipper down")) },
    });
    await expect(rejecting.dispatch(message())).resolves.toHaveLength(1);
  });

  it("refuses malformed options at creation", () => {
    const ok = channel("ok").channel;
    expect(() => createNotificationDispatcher({ channels: [{ name: "", send: async () => {} }] })).toThrow(/name/);
    expect(() =>
      createNotificationDispatcher({ channels: [{ channel: ok, events: ["deleted" as "created"] }] }),
    ).toThrow(/unknown event "deleted"/);
    expect(() => createNotificationDispatcher({ channels: [ok], retries: -1 })).toThrow(/retries/);
    expect(() => createNotificationDispatcher({ channels: [ok], timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createNotificationDispatcher({ channels: [ok], retryDelayMs: 1.5 })).toThrow(/retryDelayMs/);
  });
});
