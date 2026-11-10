import { PassThrough } from "node:stream";
import { MemoryStore } from "@siteping/adapter-memory";
import { createSitepingHandler } from "@siteping/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

function collect(stream: PassThrough): () => string {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return () => chunks.join("");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("runCli", () => {
  it("serves the configured project over the streams", async () => {
    const handler = createSitepingHandler({ store: new MemoryStore(), apiKey: "k" });
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const read = collect(output);
    const run = runCli({
      env: { SITEPING_URL: "https://site.example/api/siteping", SITEPING_API_KEY: "k", SITEPING_PROJECT: "demo" },
      input,
      output,
      errors,
      fetch: async (url, init) => handler.GET(new Request(url, init)),
    });
    input.end(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_feedback", arguments: {} } })}\n`,
    );
    expect(await run).toBe(0);
    const response = JSON.parse(read().trim());
    expect(response.result.structuredContent).toMatchObject({ project: "demo", feedbacks: [] });
  });

  it("exits 1 with the reason on stderr when the environment is incomplete", async () => {
    const errors = new PassThrough();
    const read = collect(errors);
    const output = new PassThrough();
    const code = await runCli({ env: {}, input: new PassThrough(), output, errors });
    expect(code).toBe(1);
    expect(read()).toContain("Missing SITEPING_URL, SITEPING_API_KEY, SITEPING_PROJECT");
    expect(output.read()).toBeNull();
  });
});

describe("the binary entry", () => {
  it("runs the CLI against the process environment and sets the exit code", async () => {
    for (const name of ["SITEPING_URL", "SITEPING_API_KEY", "SITEPING_PROJECT"]) vi.stubEnv(name, "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await import("../src/cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Missing SITEPING_URL");
  });
});
