import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  mergeLearnedRoutes,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

// Saved-connection fixtures for the Construct auto-link tests, built with T3's own route code.

/** A saved environment paired at one address, the way T3's pairing saves it. */
export function pairedEntry(environmentId: EnvironmentId, httpBaseUrl: string): ConnectionCatalogEntry {
  const connectionId = `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
  return {
    target: new BearerConnectionTarget({ environmentId, label: "haus-vm", connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: "haus-vm",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
    enabled: true,
  };
}

/** The same entry after the server reported a LAN address: T3 saves it as a learned route
 *  AHEAD of the paired one, borrowing its credential. */
export function withLearnedLanRoute(entry: ConnectionCatalogEntry, lanUrl: string): ConnectionCatalogEntry {
  const routes = mergeLearnedRoutes({
    entry,
    activeRoute: { target: entry.target, profile: entry.profile },
    reported: [{ httpBaseUrl: lanUrl }],
    allowInsecure: true,
  })!;
  return { ...entry, target: routes[0]!.target, profile: routes[0]!.profile, alternateRoutes: routes.slice(1) };
}
