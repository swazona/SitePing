import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parseErrorResponse, type SitepingMcpServer } from "./server.js";

/** Longest line read; anything longer is answered with a parse error and dropped. */
const MAX_LINE_LENGTH = 1024 * 1024;

export interface StdioStreams {
  input: Readable;
  output: Writable;
}

/**
 * Serve `server` over the MCP stdio transport: one JSON-RPC message per
 * line in, one per line out. Requests run concurrently and are answered as
 * they settle. Resolves once the input ends and every response is written.
 * Nothing but protocol messages goes to `output` — log to stderr.
 */
export async function serveStdio(server: SitepingMcpServer, { input, output }: StdioStreams): Promise<void> {
  const pending = new Set<Promise<void>>();
  const write = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    if (line.length > MAX_LINE_LENGTH) {
      write(parseErrorResponse());
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(parseErrorResponse());
      continue;
    }
    const task = server.handle(message).then((response) => {
      if (response !== null) write(response);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
