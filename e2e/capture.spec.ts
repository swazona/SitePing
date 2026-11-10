import { expect, type Page, type TestInfo, test } from "@playwright/test";
import type { FeedbackResponse, FeedbackResponseList } from "../packages/core/src/index.js";

/**
 * Capture features in real browsers:
 *
 * - the screenshot editor's redaction, read back from the JPEG the fake API
 *   received (IIFE bundle on server.mjs: the one that embeds html2canvas-pro);
 * - the offline queue in IndexedDB, replayed on `online` (real stack);
 * - "Record screen" with a real MediaRecorder and the real upload route.
 *   The browser's share prompt cannot be answered headless, so
 *   `getDisplayMedia` hands back a canvas stream instead: everything after
 *   the prompt is real.
 */

const FAKE = "http://localhost:3999";
const STACK = "http://localhost:3998";

function projectFor(testInfo: TestInfo, name: string): string {
  return `capture-${name}-${testInfo.project.name}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
}

/** Drag a rectangle over `selector` once annotate mode is on. */
async function drawOver(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(300, box.width - 10), box.y + Math.min(80, box.height - 10), { steps: 5 });
  await page.mouse.up();
}

async function stackFeedbacks(page: Page, endpoint: string, project: string): Promise<FeedbackResponse[]> {
  const res = await page.request.get(`${STACK}${endpoint}?projectName=${encodeURIComponent(project)}`);
  return ((await res.json()) as FeedbackResponseList).feedbacks;
}

async function openStackWidget(page: Page, query: Record<string, string>) {
  await page.goto(`${STACK}/?${new URLSearchParams(query)}`);
  await page.waitForFunction(() => !!document.querySelector("siteping-widget")?.shadowRoot?.querySelector(".sp-fab"));
}

/** FAB menu item, in the (test-mode, open) shadow root. */
async function clickFabItem(page: Page, id: string) {
  await page.evaluate(() =>
    document.querySelector("siteping-widget")?.shadowRoot?.querySelector<HTMLElement>(".sp-fab")?.click(),
  );
  await page.waitForFunction(
    (item) => !!document.querySelector("siteping-widget")?.shadowRoot?.querySelector(`[data-item-id="${item}"]`),
    id,
  );
  await page.evaluate(
    (item) =>
      document
        .querySelector("siteping-widget")
        ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-id="${item}"]`)
        ?.click(),
    id,
  );
}

test("the screenshot editor's redaction is in the pixels sent, and Escape in it keeps the form", async ({
  page,
}, testInfo) => {
  const project = projectFor(testInfo, "editor");
  await page.request.get(`${FAKE}/api/reset?projectName=${project}`);
  await page.goto(`${FAKE}?project=${project}&script=1&screenshot=1`);
  // Fine black-and-white stripes: what a redaction must leave unreadable.
  await page.addStyleTag({ content: "h1 { background: repeating-linear-gradient(90deg, #000 0 2px, #fff 2px 4px); }" });
  await page.locator(".sp-fab").click();
  await page.locator('[data-item-id="annotate"]').click();
  await drawOver(page, "h1");

  const popup = page.locator('[role="dialog"][data-siteping-ignore]').first();
  await popup.locator("textarea").fill("Hide the price");
  await popup.getByRole("button", { name: "Mark up screenshot" }).click();

  const editor = page.locator("[data-siteping-editor]");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toHaveAttribute("aria-modal", "true");
  // Escape drops nothing in progress, closes the editor — the form stays.
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(popup.locator("textarea")).toHaveValue("Hide the price");

  await popup.getByRole("button", { name: "Mark up screenshot" }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Redact" }).click();
  await expect(editor.getByRole("button", { name: "Redact" })).toHaveAttribute("aria-pressed", "true");
  // Redact the whole capture, corner to corner (inside its rounded corners).
  const canvas = (await editor.locator("canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 6, canvas.y + 6);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width + 20, canvas.y + canvas.height + 20, { steps: 4 });
  await page.mouse.up();
  await expect(editor.getByRole("button", { name: "Undo" })).toBeEnabled();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(popup.getByRole("button", { name: "Screenshot marked up" })).toBeVisible();

  await popup.getByRole("button", { name: "Send" }).click();
  await page.locator(".sp-input").first().fill("Test User");
  await page.locator(".sp-input").nth(1).fill("test@example.com");
  await page.locator(".sp-btn-primary").click();
  await expect(page.locator("#siteping-markers [data-feedback-id]")).toHaveCount(1, { timeout: 10_000 });

  const { feedbacks } = await (await page.request.get(`${FAKE}/api/siteping?projectName=${project}`)).json();
  const dataUrl = feedbacks[0].screenshotDataUrl as string;
  expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  // Redacted: the heading's 2 px stripes (see above) averaged into flat
  // blocks. Unredacted, about half the neighbouring pixels across the
  // stripes differ sharply; pixelated, next to none do.
  const sharpEdges = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sharp = 0;
    let pairs = 0;
    for (let y = 0; y < c.height; y += 3) {
      for (let x = 0; x + 1 < c.width; x++) {
        const i = (y * c.width + x) * 4;
        pairs++;
        if (Math.abs(data[i]! - data[i + 4]!) > 80) sharp++;
      }
    }
    return sharp / pairs;
  }, dataUrl);
  expect(sharpEdges).toBeLessThan(0.03);
});

test("a feedback sent offline waits in IndexedDB and is sent when the browser is back online", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(40_000);
  const project = projectFor(testInfo, "offline");
  await openStackWidget(page, { project });
  // The queue's code loads once the page is idle; the connection drops after that.
  await page.waitForFunction(() =>
    performance.getEntriesByType("resource").some((entry) => /\/offline-queue-[^/]+\.js$/.test(entry.name)),
  );

  await context.setOffline(true);
  await clickFabItem(page, "annotate");
  await page.waitForFunction(() => !!document.querySelector("div[style*='crosshair']"));
  await drawOver(page, "#target-element");
  await page.fill("textarea", "Sent from a train");
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) if (b.textContent === "Send") b.click();
  });
  // The send retries (1 + 2 + 4 s), then queues it and says so.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector("siteping-widget")?.shadowRoot?.querySelector(".sp-toast")?.textContent,
        ),
      { timeout: 20_000 },
    )
    .toBe("Saved on this device. It will be sent when you are back online.");

  // What the outbox holds: read straight from IndexedDB.
  const stored = await page.evaluate(
    () =>
      new Promise<string[] | string>((resolve) => {
        const steps: string[] = [];
        setTimeout(() => resolve(`timed out reading IndexedDB: ${steps}`), 5000);
        const open = indexedDB.open("siteping");
        open.onblocked = () => steps.push("blocked");
        open.onupgradeneeded = () => steps.push("upgrade");
        open.onerror = () => resolve(`open failed: ${open.error}`);
        open.onsuccess = () => {
          steps.push("open");
          const read = open.result.transaction("outbox").objectStore("outbox").getAll();
          read.onerror = () => resolve(`read failed: ${read.error}`);
          read.onsuccess = () => {
            resolve((read.result as Array<{ payload: { message: string } }>).map((entry) => entry.payload.message));
            open.result.close();
          };
        };
      }),
  );
  expect(stored).toEqual(["Sent from a train"]);
  expect(await stackFeedbacks(page, "/api/siteping", project)).toHaveLength(0);

  await context.setOffline(false);
  await expect
    .poll(async () => (await stackFeedbacks(page, "/api/siteping", project)).map((f) => f.message), {
      timeout: 10_000,
    })
    .toEqual(["Sent from a train"]);
  // Replayed once: the queue is empty, a reload sends nothing twice.
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("siteping-widget"));
  await page.waitForTimeout(500);
  expect(await stackFeedbacks(page, "/api/siteping", project)).toHaveLength(1);
});

test("Record screen: a real MediaRecorder recording is uploaded and attached to the feedback", async ({
  page,
}, testInfo) => {
  test.setTimeout(30_000);
  const project = projectFor(testInfo, "record");
  // Answer the share prompt with an animated canvas: the prompt itself cannot be driven headless.
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      (window as unknown as { __displayMediaOptions: unknown }).__displayMediaOptions = options;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      let frame = 0;
      setInterval(() => {
        frame += 12;
        ctx.fillStyle = `hsl(${frame % 360} 80% 50%)`;
        ctx.fillRect(0, 0, 320, 180);
      }, 50);
      return canvas.captureStream(15);
    };
  });
  await openStackWidget(page, { project, rec: "1" });

  await clickFabItem(page, "record");
  const indicator = page.locator("[data-siteping-recording]");
  await expect(indicator).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __displayMediaOptions: { preferCurrentTab?: boolean } }).__displayMediaOptions
          .preferCurrentTab,
    ),
  ).toBe(true);
  await page.waitForTimeout(1500);
  await indicator.getByRole("button", { name: "Stop recording" }).click();
  await expect(indicator).toHaveCount(0);

  // Stopping goes straight to annotate mode.
  await page.waitForFunction(() => !!document.querySelector("div[style*='crosshair']"));
  await drawOver(page, "#target-element");
  await expect(page.getByRole("button", { name: /Recording \(0:0\d\)/ })).toBeVisible();
  await page.fill("textarea", "Watch the flicker");
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) if (b.textContent === "Send") b.click();
  });

  await expect
    .poll(async () => (await stackFeedbacks(page, "/api/siteping-rec", project)).length, { timeout: 15_000 })
    .toBe(1);
  const [feedback] = await stackFeedbacks(page, "/api/siteping-rec", project);
  const recording = feedback?.diagnostics?.recording;
  expect(recording?.url).toMatch(/\/__e2e\/recordings\/\d+$/);
  expect(recording?.bytes).toBeGreaterThan(0);
  const video = await page.request.get(recording!.url);
  const bytes = await video.body();
  expect(bytes.byteLength).toBe(recording?.bytes);
  const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const isMp4 = bytes.subarray(4, 8).toString("latin1") === "ftyp";
  expect(isWebm || isMp4).toBe(true);
});
