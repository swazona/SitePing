import { defineConfig } from "tsup";
import { sitepingLibrary } from "../../tsup.preset.js";

// One entry per channel so importing ./slack never pulls the others. The
// email entry is `email-channel`: core's email.d.ts, copied by fix-dts,
// would take the name `email`.
// No @siteping/server import, not even a type (check:consistency enforces
// it): `TeamNotifier` restates the hook's types structurally, so the
// package installs next to any server version.
export default defineConfig(
  sitepingLibrary({
    platform: "neutral",
    entry: {
      index: "src/index.ts",
      slack: "src/channels/slack.ts",
      telegram: "src/channels/telegram.ts",
      whatsapp: "src/channels/whatsapp.ts",
      "email-channel": "src/channels/email.ts",
      webhook: "src/channels/webhook.ts",
    },
  }),
);
