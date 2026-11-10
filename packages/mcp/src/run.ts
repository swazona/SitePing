import type { Readable, Writable } from "node:stream";
import { createSitepingApiClient } from "./client.js";
import { readConfigFromEnv } from "./config.js";
import { createSitepingMcpServer } from "./server.js";
import { serveStdio } from "./stdio.js";

export interface RunCliOptions {
  env: Readonly<Record<string, string | undefined>>;
  input: Readable;
  output: Writable;
  /** Diagnostics — never `output`, which carries the protocol only. */
  errors: Writable;
  fetch?: typeof fetch | undefined;
}

/** The `siteping-mcp` binary: configure from `env`, serve over the streams. Resolves to the exit code. */
export async function runCli({ env, input, output, errors, fetch }: RunCliOptions): Promise<number> {
  try {
    const config = readConfigFromEnv(env);
    const client = createSitepingApiClient({ ...config, fetch });
    const server = createSitepingMcpServer({ client, authorName: config.authorName });
    await serveStdio(server, { input, output });
    return 0;
  } catch (error) {
    errors.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
