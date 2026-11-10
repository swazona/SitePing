import { expect, type Page } from "@playwright/test";

/** The stack server's endpoint with a `recordingStorage` (see stack-server.mjs). */
export const RECORDING_API = "http://localhost:3998/api/siteping-rec";

/** A React path long enough to fold in the inbox's breadcrumb. */
export const COMPONENTS = ["App", "Providers", "Router", "Layout", "CheckoutPage", "CheckoutForm"];

/** What `seedRecordedFeedback` stored, for assertions. */
export interface SeededRecording {
  url: string;
  mimeType: "video/webm" | "video/mp4";
  bytes: number;
  durationMs: number;
}

/**
 * Record a second of an animated canvas with the browser's own
 * MediaRecorder — a real, playable file — upload it through the recording
 * route, then create a feedback that names it and carries a component path.
 * Null when this browser records neither WebM nor MP4.
 */
export async function seedRecordedFeedback(page: Page, project: string): Promise<SeededRecording | null> {
  const clientId = `media-${project}`;
  // Any page of the stack's origin: the upload is a same-origin fetch.
  await page.goto("http://localhost:3998/inbox?project=__none__");
  const uploaded = await page.evaluate(
    async ({ api, project, clientId }) => {
      const mimeType = (["video/webm", "video/mp4"] as const).find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) return null;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      let hue = 0;
      const timer = setInterval(() => {
        hue = (hue + 24) % 360;
        ctx.fillStyle = `hsl(${hue} 80% 50%)`;
        ctx.fillRect(0, 0, 320, 180);
      }, 50);
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      const started = performance.now();
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      const blob = new Blob(chunks, { type: mimeType });
      const query = new URLSearchParams({ projectName: project, clientId });
      const res = await fetch(`${api}?${query}`, { method: "POST", headers: { "Content-Type": mimeType }, body: blob });
      const { url } = (await res.json()) as { url: string };
      return { url, mimeType, bytes: blob.size, durationMs: Math.round(performance.now() - started) };
    },
    { api: RECORDING_API, project, clientId },
  );
  if (!uploaded) return null;

  const res = await page.request.post(RECORDING_API, {
    data: {
      projectName: project,
      type: "bug",
      message: "The pay button does nothing",
      // The page the widget runs on: its panel lists that page's feedback.
      url: "/",
      viewport: "1280x720",
      userAgent: "Playwright",
      authorName: "Media",
      authorEmail: "media@example.com",
      clientId,
      annotations: [],
      diagnostics: { console: [], network: [], components: COMPONENTS, recording: uploaded },
    },
  });
  expect(res.status()).toBe(201);
  const created = (await res.json()) as { diagnostics?: { recording?: { url: string } } };
  // The server kept it: its storage owns the URL for this project and clientId.
  expect(created.diagnostics?.recording?.url).toBe(uploaded.url);
  return uploaded;
}
