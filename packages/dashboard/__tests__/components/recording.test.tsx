// @vitest-environment jsdom

import type { DiagnosticsSnapshot } from "@siteping/core";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSection } from "../../src/components/recording.js";
import { renderWithUi } from "../render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getElementById("siteping-inbox-recording-styles")?.remove();
});

const withRecording = (overrides: Record<string, unknown> = {}) =>
  ({
    console: [],
    network: [],
    recording: {
      url: "https://cdn.example.com/rec/1.webm",
      mimeType: "video/webm",
      durationMs: 42_000,
      bytes: 1_400_000,
      ...overrides,
    },
  }) as unknown as DiagnosticsSnapshot;

describe("RecordingSection", () => {
  it("says so when the feedback has no recording", () => {
    renderWithUi(<RecordingSection diagnostics={null} />);
    expect(screen.getByRole("region", { name: "Screen recording" }).textContent).toContain(
      "No screen recording for this feedback",
    );
    expect(document.querySelector("video")).toBeNull();
  });

  it("plays the recording with its details and a download link", async () => {
    renderWithUi(<RecordingSection diagnostics={withRecording()} />);
    const video = (await screen.findByLabelText("Screen recording player")) as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.autoplay).toBe(false);
    const source = video.querySelector("source");
    expect(source?.getAttribute("src")).toBe("https://cdn.example.com/rec/1.webm");
    expect(source?.getAttribute("type")).toBe("video/webm");
    expect(screen.getByText("0:42")).toBeTruthy();
    expect(screen.getByText("1.4 MB")).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("https://cdn.example.com/rec/1.webm");
    expect(download.hasAttribute("download")).toBe(true);
    expect(download.getAttribute("rel")).toContain("noreferrer");
    expect(document.querySelectorAll("#siteping-inbox-recording-styles")).toHaveLength(1);
  });

  it("leaves out a type, a length or a size it cannot trust", async () => {
    renderWithUi(
      <RecordingSection diagnostics={withRecording({ mimeType: "text/html", durationMs: -5, bytes: "big" })} />,
    );
    const video = await screen.findByLabelText("Screen recording player");
    expect(video.querySelector("source")?.hasAttribute("type")).toBe(false);
    expect(screen.queryByText("Duration")).toBeNull();
    expect(screen.queryByText("Size")).toBeNull();
  });

  it("falls back to the download link when the browser cannot play it", async () => {
    renderWithUi(<RecordingSection diagnostics={withRecording()} />);
    const video = await screen.findByLabelText("Screen recording player");
    fireEvent.error(video.querySelector("source") as HTMLSourceElement);
    expect(screen.getByRole("status").textContent).toBe("This browser can't play the recording. Download it instead.");
    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  it.each(["javascript:alert(1)", "data:video/webm;base64,GkXfow==", "/relative.webm"])(
    "never puts %j in a video source or a link",
    (url) => {
      const { container } = renderWithUi(<RecordingSection diagnostics={withRecording({ url })} />);
      expect(container.textContent).toContain("The recording link is not an http(s) URL, so it is not shown.");
      expect(container.querySelector("video, source, a")).toBeNull();
      expect(container.innerHTML).not.toContain(url.slice(0, 10));
    },
  );
});
