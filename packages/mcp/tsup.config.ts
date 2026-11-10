import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { sitepingLibrary } from "../../tsup.preset.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Two entries: the library (`createSitepingMcpServer`…) and the `siteping-mcp`
// binary, whose hashbang esbuild keeps from src/cli.ts. The version the
// server reports in `initialize` is written in from package.json, which
// release-please bumps.
export default defineConfig(
  sitepingLibrary({
    platform: "node",
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
    define: { __SITEPING_MCP_VERSION__: JSON.stringify(version) },
  }),
);
