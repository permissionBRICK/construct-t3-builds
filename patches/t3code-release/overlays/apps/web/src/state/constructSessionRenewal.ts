import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { renewSessions } from "./constructSessionRenewal.logic";

/** Renew this client's paired sessions that are in the last week of their lease. */
export const renewConstructSessions = createRuntimeCommand(connectionAtomRuntime, {
  label: "construct-session-renewal",
  execute: (input: { readonly savedConnections: boolean }) =>
    Effect.gen(function* () {
      const desktopToken = yield* Effect.promise(() =>
        readDesktopPrimaryBearerToken().catch(() => "unavailable"),
      );
      yield* renewSessions({ ...input, browserCookie: desktopToken === null });
    }),
});
