import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./auth/utils.ts";

/**
 * Sliding renewal for paired clients. A session in the last week of its lease
 * gets a fresh 30 days when its client asks; one that is not used in that week
 * expires as before. The session keeps its id: the renewed token carries the
 * same signed claims with a new `exp`, and the session row gets the same expiry.
 * Cookie clients receive the new token as their session cookie, bearer clients
 * in the response body.
 *
 * The token is minted from upstream's own claims and signing key, then checked
 * with SessionStore.verify. If upstream changes either, the check fails and the
 * session is simply not renewed; a client is never handed a token it cannot use.
 */
export const CONSTRUCT_SESSION_RENEW_PATH = "/construct/session/renew";
export const SESSION_RENEWAL_WINDOW = Duration.days(7);
export const RENEWED_SESSION_TTL = Duration.days(30);

const SIGNING_SECRET_NAME = "server-signing-key";
const RENEWABLE_METHODS: ReadonlySet<string> = new Set([
  "browser-session-cookie",
  "bearer-access-token",
]);

export interface SessionRenewal {
  readonly renewed: boolean;
  readonly expiresAt: DateTime.Utc | undefined;
  readonly token?: string;
}

const notRenewed = (expiresAt: DateTime.DateTime | undefined): SessionRenewal => ({
  renewed: false,
  expiresAt: expiresAt ? DateTime.toUtc(expiresAt) : undefined,
});

function decodeClaims(payload: string): Record<string, unknown> | null {
  try {
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(payload));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const renewSessionToken = Effect.fn("constructSessionRenewal.renew")(function* (
  token: string,
) {
  const sessions = yield* SessionStore.SessionStore;
  const current = yield* sessions.verify(token);
  if (
    !RENEWABLE_METHODS.has(current.method) ||
    current.proofKeyThumbprint !== undefined ||
    current.expiresAt === undefined
  ) {
    return notRenewed(current.expiresAt);
  }
  const now = yield* DateTime.now;
  const remaining = current.expiresAt.epochMilliseconds - now.epochMilliseconds;
  if (remaining > Duration.toMillis(SESSION_RENEWAL_WINDOW)) {
    return notRenewed(current.expiresAt);
  }

  const [payload] = token.split(".");
  const claims = payload ? decodeClaims(payload) : null;
  if (claims === null || claims.sid !== current.sessionId || typeof claims.exp !== "number") {
    return notRenewed(current.expiresAt);
  }
  const secret = yield* (yield* ServerSecretStore.ServerSecretStore)
    .get(SIGNING_SECRET_NAME)
    .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  if (Option.isNone(secret)) {
    return notRenewed(current.expiresAt);
  }
  const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(RENEWED_SESSION_TTL) });
  // @effect-diagnostics-next-line preferSchemaOverJson:off - re-encode upstream's claims unchanged but for exp.
  const encoded = base64UrlEncode(JSON.stringify({ ...claims, exp: expiresAt.epochMilliseconds }));
  const renewedToken = `${encoded}.${signPayload(encoded, secret.value)}`;

  const check = yield* sessions.verify(renewedToken).pipe(Effect.option);
  if (
    Option.isNone(check) ||
    check.value.sessionId !== current.sessionId ||
    check.value.expiresAt?.epochMilliseconds !== expiresAt.epochMilliseconds
  ) {
    yield* Effect.logWarning("Construct session renewal skipped: the renewed token did not verify.");
    return notRenewed(current.expiresAt);
  }

  const sql = yield* SqlClient.SqlClient;
  const updated = yield* sql<{ readonly sessionId: string }>`
    UPDATE auth_sessions
    SET expires_at = ${DateTime.formatIso(expiresAt)}
    WHERE session_id = ${current.sessionId}
      AND revoked_at IS NULL
    RETURNING session_id AS "sessionId"
  `;
  if (updated.length !== 1) {
    return notRenewed(current.expiresAt);
  }
  return { renewed: true, expiresAt, token: renewedToken } satisfies SessionRenewal;
});

const noStore = { "cache-control": "no-store" } as const;

export const constructSessionRenewalRouteLayer = HttpRouter.add(
  "POST",
  CONSTRUCT_SESSION_RENEW_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    // Authenticates exactly like the upstream API, DPoP proof checks included.
    const authenticated = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
    const credential = EnvironmentAuth.selectRequestCredential(
      request,
      sessions.cookieName,
      sessions.legacyCookieName,
    );
    if (Option.isNone(authenticated) || credential === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "unauthenticated" },
        { status: 401, headers: noStore },
      );
    }
    const renewal = yield* renewSessionToken(credential.token).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Construct session renewal failed.", cause).pipe(
          Effect.as(notRenewed(authenticated.value.expiresAt)),
        ),
      ),
    );
    const cookie = credential.source === "cookie" || credential.source === "legacy-cookie";
    const response = HttpServerResponse.jsonUnsafe(
      {
        renewed: renewal.renewed,
        expiresAt: renewal.expiresAt ? DateTime.formatIso(renewal.expiresAt) : null,
        ...(renewal.token !== undefined && !cookie ? { token: renewal.token } : {}),
      },
      { headers: noStore },
    );
    if (renewal.token === undefined || renewal.expiresAt === undefined || !cookie) {
      return response;
    }
    return yield* HttpServerResponse.setCookie(response, sessions.cookieName, renewal.token, {
      expires: DateTime.toDate(renewal.expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }).pipe(Effect.orElseSucceed(() => response));
  }),
);
