import { DEFAULT_REDACTION, type SitepingRedactionPolicy } from "./server.js";

/** What the server needs from its environment. */
export interface SitepingMcpConfig {
  endpoint: string;
  apiKey: string;
  projectName: string;
  authorName: string;
  redact: SitepingRedactionPolicy;
}

function readFlag(name: string, value: string, fallback: boolean): boolean {
  if (value === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error(`[siteping-mcp] ${name} must be true or false, got ${JSON.stringify(value)}.`);
}

/**
 * Read `SITEPING_URL`, `SITEPING_API_KEY`, `SITEPING_PROJECT`, the
 * optional `SITEPING_AUTHOR_NAME` (default `"AI agent"`) and the redaction
 * policy: `SITEPING_REDACT_SECRETS` (default true), `SITEPING_REDACT_EMAILS`
 * (default true), `SITEPING_REDACT_QUERY_STRINGS` (default false).
 *
 * @throws Error naming every missing variable, or a flag that is not a boolean.
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
    redact: {
      secrets: readFlag("SITEPING_REDACT_SECRETS", read("SITEPING_REDACT_SECRETS"), DEFAULT_REDACTION.secrets),
      emails: readFlag("SITEPING_REDACT_EMAILS", read("SITEPING_REDACT_EMAILS"), DEFAULT_REDACTION.emails),
      queryStrings: readFlag(
        "SITEPING_REDACT_QUERY_STRINGS",
        read("SITEPING_REDACT_QUERY_STRINGS"),
        DEFAULT_REDACTION.queryStrings,
      ),
    },
  };
}
