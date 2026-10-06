import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionCredential, type ConnectionCredential } from "./catalog.ts";
import {
  renewBearerCredential,
  sessionRenewalDue,
  sessionTokenExpiry,
} from "./constructSessionRenewal.ts";
import * as CredentialStore from "./credentialStore.ts";
import { ConnectionBlockedError } from "./model.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5);

function tokenExpiringAt(exp: number): string {
  return `${Base64Url.encode(JSON.stringify({ v: 1, kind: "session", sid: "s1", exp }))}.sig`;
}

function memoryStore(options?: { readonly failPut?: boolean }) {
  const puts: Array<{ readonly connectionId: string; readonly credential: ConnectionCredential }> =
    [];
  const store = CredentialStore.make({
    get: () => Effect.succeed(Option.none()),
    put: (connectionId, credential) =>
      options?.failPut
        ? Effect.fail(new ConnectionBlockedError({ reason: "configuration", detail: "read-only" }))
        : Effect.sync(() => {
            puts.push({ connectionId, credential });
          }),
    remove: () => Effect.void,
  });
  return { store, puts };
}

function stubFetch(response: () => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionRenewalDue", () => {
  it("is due only in the last week of the lease", () => {
    expect(sessionTokenExpiry(tokenExpiringAt(NOW + 10 * DAY))).toBe(NOW + 10 * DAY);
    expect(sessionRenewalDue(tokenExpiringAt(NOW + 8 * DAY), NOW)).toBe(false);
    expect(sessionRenewalDue(tokenExpiringAt(NOW + 7 * DAY), NOW)).toBe(true);
    expect(sessionRenewalDue(tokenExpiringAt(NOW + DAY), NOW)).toBe(true);
  });

  it("asks the server when the expiry cannot be read", () => {
    expect(sessionTokenExpiry("opaque-token")).toBeNull();
    expect(sessionRenewalDue("opaque-token", NOW)).toBe(true);
    expect(sessionRenewalDue(`${Base64Url.encode("{}")}.sig`, NOW)).toBe(true);
  });
});

describe("renewBearerCredential", () => {
  const input = (store: CredentialStore.ConnectionCredentialStore["Service"], token: string) => ({
    credentials: store,
    connectionId: "bearer:env-1",
    httpBaseUrl: "https://t3haus.example:8443/",
    token,
  });

  it.effect("does not ask before the last week", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const calls = stubFetch(() => Response.json({ renewed: true, token: "new" }));
      const { store, puts } = memoryStore();
      const token = tokenExpiringAt(NOW + 20 * DAY);

      expect(yield* renewBearerCredential(input(store, token))).toBe(token);
      expect(calls).toHaveLength(0);
      expect(puts).toHaveLength(0);
    }),
  );

  it.effect("stores and returns the renewed token in the last week", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const calls = stubFetch(() => Response.json({ renewed: true, token: "renewed-token" }));
      const { store, puts } = memoryStore();
      const token = tokenExpiringAt(NOW + 3 * DAY);

      expect(yield* renewBearerCredential(input(store, token))).toBe("renewed-token");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://t3haus.example:8443/construct/session/renew");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.headers).toEqual({ authorization: `Bearer ${token}` });
      expect(puts).toEqual([
        {
          connectionId: "bearer:env-1",
          credential: new BearerConnectionCredential({ token: "renewed-token" }),
        },
      ]);
    }),
  );

  it.effect("keeps the token when the server has no renewal route", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      stubFetch(() => new Response("Not Found", { status: 404 }));
      const { store, puts } = memoryStore();
      const token = tokenExpiringAt(NOW + DAY);

      expect(yield* renewBearerCredential(input(store, token))).toBe(token);
      expect(puts).toHaveLength(0);
    }),
  );

  it.effect("keeps the token when the server does not renew or is unreachable", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { store, puts } = memoryStore();
      const token = tokenExpiringAt(NOW + DAY);
      stubFetch(() => Response.json({ renewed: false, expiresAt: null }));
      expect(yield* renewBearerCredential(input(store, token))).toBe(token);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      );
      expect(yield* renewBearerCredential(input(store, token))).toBe(token);
      expect(puts).toHaveLength(0);
    }),
  );

  it.effect("connects with the renewed token even when storing it fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      stubFetch(() => Response.json({ renewed: true, token: "renewed-token" }));
      const { store } = memoryStore({ failPut: true });

      expect(yield* renewBearerCredential(input(store, tokenExpiringAt(NOW + DAY)))).toBe(
        "renewed-token",
      );
    }),
  );
});
