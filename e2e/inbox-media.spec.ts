import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { COMPONENTS, seedRecordedFeedback } from "./seed-recording.js";

// The inbox shows what the capture stores on a feedback: the screen
// recording (a lazy-loaded native player) and the React component path (a
// breadcrumb), against the real handler with a `recordingStorage`.

const ORIGIN = "http://localhost:3998";
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

for (const theme of ["light", "dark"] as const) {
  test(`inbox, ${theme}: a recorded feedback plays in the drawer, with its component path`, async ({
    page,
    browserName,
  }, testInfo) => {
    // The recording is made in the page by the browser's own MediaRecorder
    // (WebM on Chromium, MP4 on WebKit), so each engine plays a file it
    // wrote. Not yet run on Firefox: until it is, the test stays off there.
    test.skip(browserName === "firefox", "recording and playback not yet checked on Firefox");
    test.setTimeout(30_000);
    const project = `media-${theme}-${testInfo.testId}-${testInfo.retry}`;
    const recording = await seedRecordedFeedback(page, project);
    expect(recording).not.toBeNull();
    if (!recording) return;

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${ORIGIN}/inbox?endpoint=/api/siteping-rec&project=${project}&theme=${theme}`);

    // The list marks the row.
    const row = page.locator(".spd-row").first();
    await expect(row.getByRole("img", { name: "Screen recording attached" })).toBeVisible();

    await row.click();
    const drawer = page.locator(".spd-drawer");
    await expect(drawer).toBeVisible();

    // The breadcrumb: folded, then whole, then copied (clipboard reads are
    // grantable on Chromium only).
    const path = drawer.getByRole("list", { name: "Component path" });
    await expect(path.locator(".spd-crumb-name")).toHaveText(["App", "CheckoutPage", "CheckoutForm"]);
    await drawer.getByRole("button", { name: `Show all ${COMPONENTS.length} components` }).click();
    await expect(path.locator(".spd-crumb-name")).toHaveText(COMPONENTS);
    await expect(path).toBeFocused();
    if (browserName === "chromium") {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await drawer.getByRole("button", { name: "Copy component path" }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(COMPONENTS.join(" › "));
    }

    // The player: lazy, metadata only until played, and really decodable.
    const section = drawer.getByRole("region", { name: "Screen recording" });
    const video = section.getByLabel("Screen recording player");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("controls", true);
    await expect(video.locator("source")).toHaveAttribute("src", recording.url);
    await expect(video.locator("source")).toHaveAttribute("type", recording.mimeType);
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
    await expect(video).toHaveJSProperty("videoWidth", 320);
    await expect(section.getByText("This browser can't play")).toHaveCount(0);
    await expect(section.locator(".spd-player-facts")).toContainText(/Duration\s*0:01/);
    await expect(section.locator(".spd-player-facts")).toContainText(/Size\s*\d/);
    const download = section.getByRole("link", { name: "Download" });
    await expect(download).toHaveAttribute("href", recording.url);
    await expect(download).toHaveAttribute("download", "");

    // The player's styles came with its chunk, once.
    expect(await page.locator("#siteping-inbox-recording-styles").count()).toBe(1);

    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).include(".spd-root").analyze();
    expect(
      violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(",")) })),
    ).toEqual([]);
  });
}

test("inbox: a feedback without a recording says so, and has no player", async ({ page }, testInfo) => {
  const project = `media-none-${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}`;
  const res = await page.request.post(`${ORIGIN}/api/siteping`, {
    data: {
      projectName: project,
      type: "bug",
      message: "No video here",
      url: "/",
      viewport: "1280x720",
      userAgent: "Playwright",
      authorName: "Media",
      authorEmail: "media@example.com",
      clientId: `media-none-${project}`,
      annotations: [],
    },
  });
  expect(res.status()).toBe(201);
  await page.goto(`${ORIGIN}/inbox?project=${project}`);
  const row = page.locator(".spd-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "Screen recording attached" })).toHaveCount(0);
  await row.click();
  const section = page.getByRole("region", { name: "Screen recording" });
  await expect(section).toContainText("No screen recording for this feedback");
  await expect(section.locator("video")).toHaveCount(0);
});

test("widget panel: the detail view shows the component path and links the recording", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName === "firefox", "recording and playback not yet checked on Firefox");
  test.setTimeout(30_000);
  const project = `media-widget-${testInfo.testId}-${testInfo.retry}`;
  const recording = await seedRecordedFeedback(page, project);
  if (!recording) throw new Error("this browser records neither WebM nor MP4");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${ORIGIN}/?project=${project}&rec=1`);
  await page.locator(".sp-fab").click();
  await page.locator('[data-item-id="chat"]').click();
  await page.locator(".sp-card").click();
  const detail = page.locator(".sp-detail--visible");
  await expect(detail).toBeVisible();

  const componentRow = detail.locator(".sp-detail-meta-row", { hasText: "Component" });
  await expect(componentRow.locator(".sp-detail-meta-value")).toHaveText("App › … › CheckoutPage › CheckoutForm");
  await expect(componentRow.locator(".sp-detail-meta-value")).toHaveAttribute("title", COMPONENTS.join(" › "));
  const link = detail.getByRole("link", { name: /^Watch the recording \(0:01\)$/ });
  await expect(link).toHaveAttribute("href", recording.url);
  await expect(link).toHaveAttribute("target", "_blank");

  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG_AA)
    .include("siteping-widget")
    .include('[data-siteping-ignore="true"]')
    .analyze();
  expect(
    violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(",")) })),
  ).toEqual([]);
});
