/**
 * Type-level locks (vitest typecheck mode — never executed): the notifier
 * is the server's `notifyTeam` without depending on the server, for either
 * access policy, and optional settings take values read from the environment.
 */

import type { SitepingStore } from "@siteping/core";
import {
  createSitepingHandler,
  type SitepingHandler,
  type SitepingHandlerBaseOptions,
  type SitepingTeamEvent,
} from "@siteping/server";
import { describe, expectTypeOf, it } from "vitest";
import { createEmailChannel } from "../src/channels/email.js";
import { createSlackChannel } from "../src/channels/slack.js";
import { createTeamNotifier, type TeamNotificationEvent, type TeamNotifier } from "../src/index.js";

declare const store: SitepingStore;

interface Reviewer {
  id: string;
}
declare function sessionUser(request: Request): Promise<Reviewer | null>;

describe("TeamNotifier without a @siteping/server dependency", () => {
  it("takes exactly the server's team event", () => {
    expectTypeOf<TeamNotificationEvent>().toEqualTypeOf<SitepingTeamEvent>();
  });

  it("is notifyTeam of either access policy", () => {
    expectTypeOf<TeamNotifier>().toExtend<NonNullable<SitepingHandlerBaseOptions<null>["notifyTeam"]>>();
    expectTypeOf<TeamNotifier>().toExtend<NonNullable<SitepingHandlerBaseOptions<Reviewer>["notifyTeam"]>>();
  });
});

describe("createTeamNotifier", () => {
  it("plugs into both policies, keeping the inferred principal", () => {
    const notifyTeam = createTeamNotifier({
      channels: [createSlackChannel({ webhookUrl: "https://hooks.slack.com/x" })],
    });
    expectTypeOf(createSitepingHandler({ store, apiKey: "k", notifyTeam })).toEqualTypeOf<SitepingHandler>();
    createSitepingHandler({
      store,
      access: {
        authenticate: sessionUser,
        authorize: ({ principal }) => {
          expectTypeOf(principal).toEqualTypeOf<Reviewer>();
          return true;
        },
      },
      notifyTeam,
    });
  });

  it("accepts undefined for every optional setting", () => {
    const off = process.env.NOTIFY === "off";
    createTeamNotifier({
      channels: [createEmailChannel({ to: "team@acme.com", send: async () => {}, from: process.env.MAIL_FROM })],
      siteUrl: process.env.SITE_URL,
      locale: off ? undefined : "fr",
      retries: off ? undefined : 1,
      timeoutMs: undefined,
      redact: off ? false : undefined,
      teamReplies: undefined,
      formatMessage: undefined,
      dashboardUrl: undefined,
    });
  });
});
