import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  CredentialStore,
  EnvironmentRegistry,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renewSessions } from "./constructSessionRenewal.logic";

const DAY = 24 * 60 * 60 * 1000;
const PRIMARY = EnvironmentId.make("primary");
const VM = EnvironmentId.make("haus-vm");

function tokenExpiringAt(exp: number): string {
  return `${Encoding.encodeBase64Url(JSON.stringify({ sid: "s1", exp }))}.sig`;
}

function setup(input: {
  readonly vmToken: string;
  readonly vmEnabled?: boolean;
  readonly vmConnectionId?: string;
  readonly vmAuthorization?: "t3-connect";
}) {
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>([
    [
      PRIMARY,
      {
        target: new PrimaryConnectionTarget({
          environmentId: PRIMARY,
          label: "This server",
          httpBaseUrl: "https://t3haus.example:8443/",
          wsBaseUrl: "wss://t3haus.example:8443/",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ],
    [
      VM,
      {
        target: new BearerConnectionTarget({
          environmentId: VM,
          label: "haus-vm",
          connectionId: input.vmConnectionId ?? "bearer:haus-vm",
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: input.vmConnectionId ?? "bearer:haus-vm",
            environmentId: VM,
            label: "haus-vm",
            httpBaseUrl: "http://haus-vm.example:5177/",
            wsBaseUrl: "ws://haus-vm.example:5177/",
            ...(input.vmAuthorization ? { authorization: input.vmAuthorization } : {}),
          }),
        ),
        enabled: input.vmEnabled ?? true,
      },
    ],
  ]);
  const stored = new Map<string, ConnectionCredential>([
    ["bearer:haus-vm", new BearerConnectionCredential({ token: input.vmToken })],
  ]);
  const retried: Array<EnvironmentId> = [];
  const fetchCalls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return String(url).startsWith("http://haus-vm.example")
        ? Response.json({ renewed: true, token: "renewed-token" })
        : Response.json({ renewed: false, expiresAt: null });
    }),
  );
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      EnvironmentRegistry.EnvironmentRegistry | CredentialStore.ConnectionCredentialStore
    >,
  ) =>
    Effect.gen(function* () {
      const entriesRef = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        entries,
      );
      return yield* effect.pipe(
        Effect.provideService(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            entries: entriesRef,
            retryNow: (environmentId: EnvironmentId) =>
              Effect.sync(() => {
                retried.push(environmentId);
              }),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
        Effect.provideService(
          CredentialStore.ConnectionCredentialStore,
          CredentialStore.make({
            get: (connectionId) => Effect.succeed(Option.fromUndefinedOr(stored.get(connectionId))),
            put: (connectionId, credential) =>
              Effect.sync(() => {
                stored.set(connectionId, credential);
              }),
            remove: () => Effect.void,
          }),
        ),
      );
    });
  return { stored, retried, fetchCalls, provide };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renewSessions", () => {
  it("asks the page's own server with its cookie", async () => {
    const { fetchCalls, provide } = setup({ vmToken: tokenExpiringAt(Date.now() + 20 * DAY) });
    await Effect.runPromise(provide(renewSessions({ browserCookie: true, savedConnections: false })));

    expect(fetchCalls).toEqual([
      {
        url: "https://t3haus.example:8443/construct/session/renew",
        init: { method: "POST", signal: expect.any(AbortSignal), credentials: "include" },
      },
    ]);
  });

  it("leaves the primary alone in Desktop, which uses a bearer of its own", async () => {
    const { fetchCalls, provide } = setup({ vmToken: tokenExpiringAt(Date.now() + 20 * DAY) });
    await Effect.runPromise(provide(renewSessions({ browserCookie: false, savedConnections: true })));

    expect(fetchCalls).toHaveLength(0);
  });

  it("renews a saved connection in its last week, stores it and reconnects once", async () => {
    const { stored, retried, fetchCalls, provide } = setup({
      vmToken: tokenExpiringAt(Date.now() + 2 * DAY),
    });
    await Effect.runPromise(provide(renewSessions({ browserCookie: false, savedConnections: true })));

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "http://haus-vm.example:5177/construct/session/renew",
    ]);
    expect(stored.get("bearer:haus-vm")).toEqual(
      new BearerConnectionCredential({ token: "renewed-token" }),
    );
    expect(retried).toEqual([VM]);
  });

  it("does nothing for a switched-off connection or one not yet due", async () => {
    const off = setup({ vmToken: tokenExpiringAt(Date.now() + DAY), vmEnabled: false });
    await Effect.runPromise(
      off.provide(renewSessions({ browserCookie: false, savedConnections: true })),
    );
    expect(off.fetchCalls).toHaveLength(0);

    const early = setup({ vmToken: tokenExpiringAt(Date.now() + 20 * DAY) });
    await Effect.runPromise(
      early.provide(renewSessions({ browserCookie: false, savedConnections: true })),
    );
    expect(early.fetchCalls).toHaveLength(0);
    expect(early.retried).toHaveLength(0);
  });

  it("renews the credential a learned route borrows and skips T3 Connect routes", async () => {
    const learned = setup({
      vmToken: tokenExpiringAt(Date.now() + 2 * DAY),
      vmConnectionId: "learned:haus-vm:http://haus-vm.example:5177@bearer:haus-vm",
    });
    await Effect.runPromise(
      learned.provide(renewSessions({ browserCookie: false, savedConnections: true })),
    );
    expect(learned.stored.get("bearer:haus-vm")).toEqual(
      new BearerConnectionCredential({ token: "renewed-token" }),
    );
    expect(learned.retried).toEqual([VM]);

    const relay = setup({
      vmToken: tokenExpiringAt(Date.now() + 2 * DAY),
      vmAuthorization: "t3-connect",
    });
    await Effect.runPromise(
      relay.provide(renewSessions({ browserCookie: false, savedConnections: true })),
    );
    expect(relay.fetchCalls).toHaveLength(0);
  });
});
