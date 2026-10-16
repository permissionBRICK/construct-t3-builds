import { useAtomValue } from "@effect/atom-react";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { isElectron } from "../env";
import { setLocalStorageItem } from "../hooks/useLocalStorage";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  CONSTRUCT_LINKED_TARGET_KIND,
  constructEnvironmentConnected,
  constructLinkedRemotes,
  constructRelinkCandidates,
  planConstructAutoLink,
  planConstructRelink,
} from "./constructInstances.logic";
import {
  constructPairedRouteUrl,
  linkConstructInstance,
  relinkConstructInstance,
} from "./constructInstances.link";
import { getConstructUpdateInfo } from "./constructUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Auto-link (plan §4.12 "T3 Desktop topology"): every Construct VM of this PC that runs
 * T3 and is not yet one of this app's remote environments gets linked on its own — the
 * default local VM included. Runs off the same facts the Providers page renders (the
 * Construct update state's instances + the app's environment list), through
 * planConstructAutoLink's rule: never twice, never a connection the user removed,
 * backed off after a failure, nothing while a Construct script runs.
 *
 * One attempt per instance per app session: the marker the main process records is
 * what the NEXT session consults, and an attempt whose marker could not be written must
 * not loop meanwhile. Mounted at the root; renders nothing, and nothing in browsers or
 * stock builds.
 *
 * Re-link: a linked remote of an instance whose session still has T3's old permission
 * set (the VM's T3 was upgraded under the old link) is paired again the same way, once
 * per app session (planConstructRelink). Construct handles those, so upstream's
 * "Permissions have changed … pair again" notice is dismissed for them.
 */
export function ConstructAutoLink() {
  return isElectron ? <ConstructAutoLinkContent /> : null;
}

function ConstructAutoLinkContent() {
  const state = useDesktopUpdateState();
  const info = getConstructUpdateInfo(state);
  const { environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const attemptedRef = useRef(new Set<string>());
  const relinkAttemptedRef = useRef(new Set<string>());
  const [legacy, setLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const reportLegacy = useCallback((environmentId: string, isLegacy: boolean) => {
    setLegacy((current) => {
      if (current.has(environmentId) === isLegacy) return current;
      const next = new Set(current);
      if (isLegacy) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  }, []);

  const remotes = useMemo(
    () =>
      constructLinkedRemotes(
        environments.map((environment) => ({
          environmentId: String(environment.environmentId),
          label: environment.label,
          displayUrl: environment.displayUrl,
          targetKind: environment.entry.target._tag,
          connected: constructEnvironmentConnected(environment),
        })),
      ),
    [environments],
  );

  // The same remotes, at the address of the route they were PAIRED at (the re-link's).
  const pairedRemotes = useMemo(
    () =>
      environments.flatMap((environment) => {
        if (environment.entry.target._tag !== CONSTRUCT_LINKED_TARGET_KIND) return [];
        const baseUrl = constructPairedRouteUrl(environment.entry);
        return baseUrl === null ? [] : [{ id: String(environment.environmentId), baseUrl }];
      }),
    [environments],
  );

  const canLink = typeof window.desktopBridge?.linkConstructInstance === "function";
  // The remotes this PC's Construct would pair again: only their sessions are probed.
  const managedEnvironmentIds = useMemo(() => {
    if (!canLink || info === null || info.scriptsDir === null) return [];
    const ids = new Set(
      constructRelinkCandidates(pairedRemotes, info.instances).map((candidate) => candidate.environmentId),
    );
    return environments
      .map((environment) => environment.environmentId)
      .filter((environmentId) => ids.has(String(environmentId)));
  }, [canLink, environments, info, pairedRemotes]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || info === null) return;
    if (typeof bridge.linkConstructInstance !== "function") return;
    const names = planConstructAutoLink({
      info,
      remotes,
      inFlight: attemptedRef.current,
      now: Date.now(),
    });
    for (const name of names) {
      attemptedRef.current.add(name);
      void linkConstructInstance({ bridge, name, connectPairing }).then((outcome) => {
        if (outcome.ok) {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Linked ${name}`,
              description: `The Construct VM "${name}" was added as a remote environment. It reconnects on app startup.`,
            }),
          );
          return;
        }
        if (outcome.interrupted) {
          // The app is closing; the next start tries again.
          attemptedRef.current.delete(name);
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not link ${name}`,
            description: `${outcome.error} Retry from Settings → Providers → Construct.`,
          }),
        );
      });
    }
  }, [connectPairing, info, remotes]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || info === null) return;
    if (typeof bridge.linkConstructInstance !== "function") return;
    const plans = planConstructRelink({
      info,
      remotes: pairedRemotes,
      legacy,
      inFlight: relinkAttemptedRef.current,
    });
    for (const plan of plans) {
      const environmentId = managedEnvironmentIds.find((id) => String(id) === plan.environmentId);
      if (environmentId === undefined) continue;
      relinkAttemptedRef.current.add(plan.name);
      void relinkConstructInstance({
        bridge,
        name: plan.name,
        environmentId,
        baseUrl: plan.baseUrl,
        connectPairing,
      }).then((outcome) => {
        if (outcome.ok) {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Updated permissions for ${plan.name}`,
              description: `T3 Code on the Construct VM "${plan.name}" changed its permissions, so this app paired with it again.`,
            }),
          );
          return;
        }
        if (outcome.interrupted) {
          relinkAttemptedRef.current.delete(plan.name);
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update permissions for ${plan.name}`,
            description: `${outcome.error} Pair again from Settings → Connections.`,
          }),
        );
      });
    }
  }, [connectPairing, info, legacy, managedEnvironmentIds, pairedRemotes]);

  return managedEnvironmentIds.map((environmentId) => (
    <ConstructLegacySessionProbe
      key={environmentId}
      environmentId={environmentId}
      onReport={reportLegacy}
    />
  ));
}

/**
 * Reports whether one Construct-managed remote's session still has T3's old permission
 * set — the same test upstream's PermissionUpdateNotice makes. A layout effect, so it
 * runs before that notice's passive effect in the same commit: the dismissal it writes
 * (upstream's own key) keeps the notice from asking the user to pair by hand.
 */
function ConstructLegacySessionProbe({
  environmentId,
  onReport,
}: {
  environmentId: EnvironmentId;
  onReport: (environmentId: string, legacy: boolean) => void;
}) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const legacy =
    session._tag === "Success" && !session.waiting && sessionHasLegacyPermissions(session.value);
  useLayoutEffect(() => {
    if (legacy) {
      try {
        setLocalStorageItem(`t3code:permission-update:v1:${environmentId}`, true, Schema.Boolean);
      } catch {
        // Then upstream's notice shows as well; the re-link does not depend on it.
      }
    }
    onReport(String(environmentId), legacy);
  }, [environmentId, legacy, onReport]);
  return null;
}
