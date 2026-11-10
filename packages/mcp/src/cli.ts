#!/usr/bin/env node
import { runCli } from "./run.js";

// `npx @siteping/mcp` — the MCP stdio server.
void runCli({ env: process.env, input: process.stdin, output: process.stdout, errors: process.stderr }).then((code) => {
  process.exitCode = code;
});
