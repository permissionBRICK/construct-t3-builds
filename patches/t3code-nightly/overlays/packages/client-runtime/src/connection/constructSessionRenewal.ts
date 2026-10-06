// @effect-diagnostics globalFetchInEffect:off - plain fetch needs no HttpClient in the connection broker, and sends the browser's cookie.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { BearerConnectionCredential } from "./catalog.ts";
import type { ConnectionCredentialStore } from "./credentialStore.ts";

/**
 * Construct: paired sessions stay alive while they are in use. A Construct T3 server
 * (apps/server/src/constructSessionRenewal.ts) gives a session in the last week of its
 * 30-day lease a fresh 30 days when its client asks. A browser's cookie session is
 * renewed by the response itself; a saved bearer credential is replaced here.
 * Servers without the route answer 404 and the session expires as before.
 */
export const CONSTRUCT_SESSION_RENEW_PATH = "/construct/session/renew";
export const SESSION_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RENEWAL_TIMEOUT_MS = 5_000;

/** The `exp` claim (epoch ms) of a T3 session token, or null when it cannot be read. */
export function sessionTokenExpiry(token: string): number | null {
  const [payload] = token.split(".");
  if (!payload) return null;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (Result.isFailure(decoded)) return null;
  try {
    const claims: unknown = JSON.parse(decoded.success);
    const exp = typeof claims === "object" && claims !== null ? Reflect.get(claims, "exp") : null;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Whether to ask the server: in the last week, or when the token's expiry is unreadable. */
export function sessionRenewalDue(token: string, now: number): boolean {
  const expiry = sessionTokenExpiry(token);
  return expiry === null || expiry - now <= SESSION_RENEWAL_WINDOW_MS;
}

/**
 * POST the renewal route. Never fails: no answer, a server without the route, or an
 * unexpected body all read as "not renewed".
 */
export const requestSessionRenewal = (
  httpBaseUrl: string,
  init: { readonly bearerToken?: string; readonly credentials?: "include" },
): Effect.Effect<{ readonly renewed: boolean; readonly token?: string }> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(environmentEndpointUrl(httpBaseUrl, CONSTRUCT_SESSION_RENEW_PATH), {
        method: "POST",
        signal,
        ...(init.credentials ? { credentials: init.credentials } : {}),
        ...(init.bearerToken ? { headers: { authorization: `Bearer ${init.bearerToken}` } } : {}),
      });
      if (!response.ok) return { renewed: false };
      const body: unknown = await response.json();
      const renewed = typeof body === "object" && body !== null && Reflect.get(body, "renewed") === true;
      const token = typeof body === "object" && body !== null ? Reflect.get(body, "token") : undefined;
      return typeof token === "string" && token.length > 0 ? { renewed, token } : { renewed };
    },
    catch: () => "unavailable" as const,
  }).pipe(
    Effect.timeout(RENEWAL_TIMEOUT_MS),
    Effect.orElseSucceed(() => ({ renewed: false })),
  );

/**
 * Renew a saved bearer credential that is in the last week of its lease and store the
 * new token. Returns the token to connect with: the renewed one, or the given one.
 */
export const renewBearerCredential = Effect.fn("clientRuntime.connection.constructRenewBearer")(
  function* (input: {
    readonly credentials: ConnectionCredentialStore["Service"];
    readonly connectionId: string;
    readonly httpBaseUrl: string;
    readonly token: string;
  }) {
    if (!sessionRenewalDue(input.token, yield* Clock.currentTimeMillis)) {
      return input.token;
    }
    const renewal = yield* requestSessionRenewal(input.httpBaseUrl, { bearerToken: input.token });
    if (!renewal.renewed || renewal.token === undefined) {
      return input.token;
    }
    // The old token stays valid until its own expiry, so a failed write only means
    // the next connection asks again.
    yield* input.credentials
      .put(input.connectionId, new BearerConnectionCredential({ token: renewal.token }))
      .pipe(Effect.ignore);
    return renewal.token;
  },
);
