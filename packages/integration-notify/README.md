[![npm version](https://img.shields.io/npm/v/@siteping/integration-notify)](https://www.npmjs.com/package/@siteping/integration-notify)
[![Docs](https://img.shields.io/badge/docs-siteping.dev-0066ff)](https://siteping.dev/docs/notifications)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)

# @siteping/integration-notify

Tell your team when a [SitePing](https://github.com/NeosiaNexus/SitePing) feedback comes in, is resolved or reopened, or gets a reply: Slack, Telegram, WhatsApp, email or a signed webhook (n8n, Discord, Teams…), through `@siteping/server`'s `notifyTeam`. One channel contract, so any other outlet is a dozen lines. Visitor text is redacted and escaped for each outlet; destinations come from your configuration only.

**[Documentation](https://siteping.dev/docs/notifications)**

## Install

```bash
npm install @siteping/integration-notify
```

Node ≥ 22, or any runtime with the Fetch API and Web Crypto. No dependencies. It plugs into `@siteping/server` without depending on it.

## Quick start

```ts
import { createSitepingHandler } from "@siteping/server";
import { createTeamNotifier } from "@siteping/integration-notify";
import { createSlackChannel } from "@siteping/integration-notify/slack";
// or: createTelegramChannel from "/telegram", createWhatsAppChannel from "/whatsapp",
//     createEmailChannel from "/email", createWebhookChannel from "/webhook"

export const { GET, POST, PATCH, DELETE, OPTIONS } = createSitepingHandler({
  store,
  apiKey: process.env.SITEPING_API_KEY,
  notifyTeam: createTeamNotifier({
    siteUrl: "https://acme.com",
    channels: [createSlackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })],
  }),
});
```

## Documentation

Every channel's options and limits, routing and filters, retries and timeouts, redaction, signature verification and custom channels: **[siteping.dev/docs/notifications](https://siteping.dev/docs/notifications)**.
