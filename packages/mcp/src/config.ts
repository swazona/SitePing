/** What the server needs from its environment. */
export interface SitepingMcpConfig {
  endpoint: string;
  apiKey: string;
  projectName: string;
  authorName: string;
}

/**
 * Read `SITEPING_URL`, `SITEPING_API_KEY`, `SITEPING_PROJECT` and the
 * optional `SITEPING_AUTHOR_NAME` (default `"AI agent"`).
 *
 * @throws Error naming every missing variable.
 */
export function readConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SitepingMcpConfig {
  const read = (name: string) => env[name]?.trim() ?? "";
  const missing = ["SITEPING_URL", "SITEPING_API_KEY", "SITEPING_PROJECT"].filter((name) => read(name) === "");
  if (missing.length > 0) {
    throw new Error(
      `[siteping-mcp] Missing ${missing.join(", ")}. Set SITEPING_URL to the URL of your SitePing endpoint ` +
        "(e.g. https://example.com/api/siteping), SITEPING_API_KEY to its apiKey and SITEPING_PROJECT to the widget's projectName.",
    );
  }
  return {
    endpoint: read("SITEPING_URL"),
    apiKey: read("SITEPING_API_KEY"),
    projectName: read("SITEPING_PROJECT"),
    authorName: read("SITEPING_AUTHOR_NAME") || "AI agent",
  };
}
