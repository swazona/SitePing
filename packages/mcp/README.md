[![npm version](https://img.shields.io/npm/v/@siteping/mcp)](https://www.npmjs.com/package/@siteping/mcp)
[![Docs](https://img.shields.io/badge/docs-siteping.dev-0066ff)](https://siteping.dev/docs/mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)

# @siteping/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [SitePing](https://github.com/NeosiaNexus/SitePing): your AI coding agent lists the feedback reviewers left on your site, reads one with its full context (page, element, browser, console errors, failed requests, thread, screenshot), fixes it in the code, replies to the reviewer and resolves it. It talks to your `@siteping/server` endpoint over HTTP with its API key.

**[Documentation](https://siteping.dev/docs/mcp)**

Node ≥ 22, stdio transport, no dependencies.

## Configuration

| Variable | |
|---|---|
| `SITEPING_URL` | Your handler's URL, e.g. `https://example.com/api/siteping` |
| `SITEPING_API_KEY` | The handler's `apiKey` — keep it out of committed files |
| `SITEPING_PROJECT` | The widget's `projectName` |
| `SITEPING_AUTHOR_NAME` | Optional: the name replies are posted under (default `AI agent`) |
| `SITEPING_REDACT_SECRETS` / `_EMAILS` / `_QUERY_STRINGS` | Optional: what is redacted from every tool's output (default `true` / `true` / `false`) |

### Claude Code

```bash
claude mcp add siteping \
  --env SITEPING_URL=https://example.com/api/siteping \
  --env SITEPING_API_KEY="$SITEPING_API_KEY" \
  --env SITEPING_PROJECT=my-project \
  -- npx -y @siteping/mcp
```

Or in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "siteping": {
      "command": "npx",
      "args": ["-y", "@siteping/mcp"],
      "env": {
        "SITEPING_URL": "https://example.com/api/siteping",
        "SITEPING_API_KEY": "${SITEPING_API_KEY}",
        "SITEPING_PROJECT": "my-project"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "siteping": {
      "command": "npx",
      "args": ["-y", "@siteping/mcp"],
      "env": {
        "SITEPING_URL": "https://example.com/api/siteping",
        "SITEPING_API_KEY": "${env:SITEPING_API_KEY}",
        "SITEPING_PROJECT": "my-project"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.siteping]
command = "npx"
args = ["-y", "@siteping/mcp"]

[mcp_servers.siteping.env]
SITEPING_URL = "https://example.com/api/siteping"
SITEPING_API_KEY = "your-api-key"
SITEPING_PROJECT = "my-project"
```

## Tools

| Tool | |
|---|---|
| `list_feedback` | Filter by status (default open + in progress), type, URL substring, date (`since: "7d"` or an ISO date) and message text; paginated with a cursor |
| `get_feedback` | One feedback rendered as an AI prompt (or Markdown, text, JSON), tokens and emails redacted |
| `get_screenshot` | The captured screenshot, as image content |
| `update_status` | `open`, `in_progress`, `resolved` or `wont_fix` |
| `add_reply` | A reply in the thread, as the team — the reviewer reads it in the widget |

Everything a reviewer wrote reaches the agent quoted and marked as data, not instructions. Review what an agent changes all the same: see [Security](https://siteping.dev/docs/mcp#security).

## License

[MIT](https://github.com/NeosiaNexus/SitePing/blob/main/LICENSE)
