import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";
import { renewSessionToken } from "./constructSessionRenewal.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const testLayer = SessionStore.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("renewal-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-renewal-test-" })),
);

const days = (value: number) => Duration.toMillis(Duration.days(value));

describe("renewSessionToken", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("leaves a session alone until the last week of its lease", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        yield* TestClock.adjust(Duration.days(22));

        const renewal = yield* renewSessionToken(issued.token);
        expect(renewal.renewed).toBe(false);
        expect(renewal.token).toBeUndefined();
        expect(renewal.expiresAt?.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("extends the same session to 30 days from now in its last week", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({
          method: "bearer-access-token",
          client: { label: "construct-t3-desktop-test", deviceType: "desktop" },
        });
        yield* TestClock.adjust(Duration.days(24));
        const now = yield* DateTime.now;

        const renewal = yield* renewSessionToken(issued.token);
        expect(renewal.renewed).toBe(true);
        expect(renewal.expiresAt?.epochMilliseconds).toBe(now.epochMilliseconds + days(30));
        const renewed = yield* sessions.verify(renewal.token!);
        expect(renewed.sessionId).toBe(issued.sessionId);
        expect(renewed.method).toBe("bearer-access-token");
        expect(renewed.scopes).toEqual(issued.scopes);
        expect(renewed.client.label).toBe("construct-t3-desktop-test");

        // Past the original lease: the old token is expired, the renewed one and
        // the session row (which websocket tickets check) carry the new expiry.
        yield* TestClock.adjust(Duration.days(10));
        const oldToken = yield* Effect.flip(sessions.verify(issued.token));
        expect(oldToken._tag).toBe("SessionTokenExpiredError");
        expect((yield* sessions.verify(renewal.token!)).sessionId).toBe(issued.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const viaTicket = yield* sessions.verifyWebSocketToken(ticket.token);
        expect(viaTicket.expiresAt?.epochMilliseconds).toBe(renewal.expiresAt?.epochMilliseconds);
        const listed = (yield* sessions.listActive()).find(
          (session) => session.sessionId === issued.sessionId,
        );
        expect(listed?.expiresAt.epochMilliseconds).toBe(renewal.expiresAt?.epochMilliseconds);
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("renews browser cookie sessions", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "browser-session-cookie" });
        yield* TestClock.adjust(Duration.days(29));

        const renewal = yield* renewSessionToken(issued.token);
        expect(renewal.renewed).toBe(true);
        expect((yield* sessions.verify(renewal.token!)).method).toBe("browser-session-cookie");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("lets an unused session expire", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        yield* TestClock.adjust(Duration.days(31));

        const error = yield* Effect.flip(renewSessionToken(issued.token));
        expect(error._tag).toBe("SessionTokenExpiredError");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("never renews a revoked session", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        yield* TestClock.adjust(Duration.days(25));
        yield* sessions.revoke(issued.sessionId);

        const error = yield* Effect.flip(renewSessionToken(issued.token));
        expect(error._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(testLayer)),
    );

    it.effect("leaves short-lived proof-bound tokens to their own refresh", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({
          method: "dpop-access-token",
          proofKeyThumbprint: "relay-proof-key",
          ttl: Duration.hours(1),
        });
        yield* TestClock.adjust(Duration.minutes(30));

        const renewal = yield* renewSessionToken(issued.token);
        expect(renewal.renewed).toBe(false);
      }).pipe(Effect.provide(testLayer)),
    );
  });
});
