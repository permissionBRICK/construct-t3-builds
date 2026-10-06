import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  ConstructSessionRenewal,
  credentialConnectionId,
  CredentialStore,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

/**
 * Construct: renew this client's paired sessions in the last week of their lease
 * (see client-runtime connection/constructSessionRenewal.ts).
 *
 * - `browserCookie`: the page's own server session is an httpOnly cookie, which the
 *   response renews. Desktop authenticates its own server with a bearer instead.
 * - `savedConnections`: saved bearer connections renew when they connect; this also
 *   covers one that stays connected into its last week. It reconnects once so the
 *   live connection uses the renewed token. A learned route renews the credential it
 *   borrows; T3 Connect routes have short-lived tokens of their own.
 */
export const renewSessions = Effect.fn("construct.sessionRenewal.renewSessions")(function* (input: {
  readonly browserCookie: boolean;
  readonly savedConnections: boolean;
}) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = [...(yield* SubscriptionRef.get(registry.entries)).values()];
  if (input.browserCookie) {
    for (const entry of entries) {
      if (entry.target._tag === "PrimaryConnectionTarget") {
        yield* ConstructSessionRenewal.requestSessionRenewal(entry.target.httpBaseUrl, {
          credentials: "include",
        });
      }
    }
  }
  if (!input.savedConnections) return;

  const credentials = yield* CredentialStore.ConnectionCredentialStore;
  for (const entry of entries) {
    const target = entry.target;
    const profile = Option.getOrUndefined(entry.profile);
    if (target._tag !== "BearerConnectionTarget" || !entry.enabled || !isBearerProfile(profile)) {
      continue;
    }
    if (profile.authorization === "t3-connect") continue;
    const connectionId = credentialConnectionId(target.connectionId);
    const credential = Option.getOrUndefined(
      yield* credentials.get(connectionId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (!isBearerCredential(credential)) continue;
    const token = yield* ConstructSessionRenewal.renewBearerCredential({
      credentials,
      connectionId,
      httpBaseUrl: profile.httpBaseUrl,
      token: credential.token,
    });
    if (token !== credential.token) {
      yield* registry.retryNow(target.environmentId);
    }
  }
});
