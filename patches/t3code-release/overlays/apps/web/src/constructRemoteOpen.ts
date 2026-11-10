import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ConstructUpdateInfo, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";

import { constructPairedRouteUrl } from "./components/constructInstances.link";
import { constructInstanceForRemote } from "./components/constructInstances.logic";
import { getConstructUpdateInfo } from "./components/constructUpdate.logic";
import { desktopUpdateStateAtom } from "./state/desktopUpdate";

/** The ssh target "Open in" uses for a remote environment, in the shape of an SSH connection's. */
export interface ConstructSshTarget {
  readonly alias: string;
  readonly username: null;
}

/**
 * A Construct VM of this PC opens through the `Host <hostAlias>` its Construct wrote to
 * `~/.ssh/config` (the Companion's link), not the advertised `<hostname>.local`, which
 * resolves only on the VM's network. Null for other servers, browsers, unread instances.
 */
export function constructSshTargetFor(
  environmentId: string,
  entry: ConnectionCatalogEntry,
  info: ConstructUpdateInfo | null,
): ConstructSshTarget | null {
  if (info === null) return null;
  const baseUrl = constructPairedRouteUrl(entry);
  if (baseUrl === null) return null;
  const instance = constructInstanceForRemote({ id: environmentId, baseUrl }, info.instances);
  return instance === null ? null : { alias: instance.hostAlias, username: null };
}

/** constructSshTargetFor with the Desktop app's Construct instances, read inside an atom so
 *  the resolution follows them. */
export function constructSshTarget(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  entry: ConnectionCatalogEntry,
): ConstructSshTarget | null {
  const state = AsyncResult.getOrElse(get(desktopUpdateStateAtom), () => null);
  return constructSshTargetFor(String(environmentId), entry, getConstructUpdateInfo(state));
}
