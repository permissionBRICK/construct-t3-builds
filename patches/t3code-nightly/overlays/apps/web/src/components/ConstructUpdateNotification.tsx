import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useEnvironments } from "../state/environments";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import { constructEnvironmentConnected, constructLinkedRemotes } from "./constructInstances.logic";
import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { setConstructLinkedRemotes, startConstructUpdate } from "./constructUpdate";
import {
  getConstructDisabledReason,
  getConstructThreadUpdateInfo,
  getConstructUpdateActionLabel,
  getConstructUpdateDetail,
  getConstructUpdateHeadline,
  getConstructUpdateInfo,
  getConstructUpdateNotificationKey,
} from "./constructUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

// The key of upstream's former provider-update dismissal store, which this popup shared:
// offers users already closed stay dismissed.
const CONSTRUCT_UPDATE_DISMISSALS_STORAGE_KEY = "t3code:provider-update-dismissals:v1";
const ConstructUpdateDismissalsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });

function useDismissedConstructUpdateNotificationKeys() {
  const [dismissals, setDismissals] = useLocalStorage(
    CONSTRUCT_UPDATE_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    ConstructUpdateDismissalsSchema,
  );
  const dismissedNotificationKeys = new Set(dismissals.keys);
  const dismissNotificationKey = (key: string) => {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0 || dismissedNotificationKeys.has(trimmedKey)) return;
    setDismissals({ keys: [...dismissals.keys, trimmedKey] });
  };
  return { dismissedNotificationKeys, dismissNotificationKey };
}

const seenConstructUpdateNotificationKeys = new Set<string>();
type ConstructToastId = ReturnType<typeof toastManager.add>;

/**
 * The Construct update popup: when the Desktop app starts offering an action (a Construct
 * update for this PC, or a VM reprovision because the VM is behind the installed Construct
 * or a newer upstream T3 Code exists), raise one prompt per distinct offer with the action
 * as its primary button. Closing it dismisses that offer for good (persisted below); the
 * sidebar pill and the Providers entry keep showing it. Nothing renders in browsers or
 * stock Desktop builds.
 */
export function ConstructUpdateNotification() {
  return isElectron ? <ConstructUpdateNotificationContent /> : null;
}

function ConstructUpdateNotificationContent() {
  const navigate = useNavigate();
  const state = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const threadRef = resolveActiveThreadRouteRef(routeTarget, draftThread);
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
  // The app-wide T3 Code update targets the connected VMs; this component is always mounted.
  useEffect(() => setConstructLinkedRemotes(remotes), [remotes]);
  const remote = remotes.find((candidate) => candidate.id === threadRef?.environmentId) ?? null;
  const info = getConstructThreadUpdateInfo(getConstructUpdateInfo(state), remote);
  // Nothing to offer while updates are disabled: the facts stay visible in Settings.
  const notificationKey =
    info === null || getConstructDisabledReason(state) !== null
      ? null
      : getConstructUpdateNotificationKey(info);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedConstructUpdateNotificationKeys();
  const activeToastRef = useRef<{
    readonly key: string;
    readonly toastId: ConstructToastId;
  } | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;

  const closeActiveToast = useCallback(() => {
    const active = activeToastRef.current;
    if (active === null) return;
    seenConstructUpdateNotificationKeys.delete(active.key);
    toastManager.close(active.toastId);
    activeToastRef.current = null;
  }, []);

  useEffect(() => closeActiveToast, [closeActiveToast]);

  useEffect(() => {
    // The offer changed (or went away, e.g. the script was launched elsewhere): drop a
    // prompt the user has not acted on.
    const active = activeToastRef.current;
    if (active !== null && active.key !== notificationKey) {
      closeActiveToast();
    }
    if (
      info === null ||
      notificationKey === null ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenConstructUpdateNotificationKeys.has(notificationKey) ||
      activeToastRef.current !== null
    ) {
      return;
    }
    const action = info.action;
    if (action === null) return;
    seenConstructUpdateNotificationKeys.add(notificationKey);

    let toastId!: ConstructToastId;
    const runAction = () => {
      const bridge = window.desktopBridge;
      const current = infoRef.current;
      // A queued click from a toast replaced during navigation must never launch
      // the new thread's VM under the old VM's displayed name.
      if (
        !bridge ||
        current === null ||
        getConstructUpdateNotificationKey(current) !== notificationKey
      )
        return;
      toastManager.close(toastId);
      activeToastRef.current = null;
      void startConstructUpdate(bridge, current);
    };
    const openProviderSettings = () => {
      toastManager.close(toastId);
      activeToastRef.current = null;
      void navigate({ to: "/settings/providers" });
    };
    toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: getConstructUpdateHeadline(info),
        description: getConstructUpdateDetail(info),
        timeout: 0,
        actionProps: {
          children:
            action === "reprovision"
              ? `Reprovision ${info.vmName}`
              : getConstructUpdateActionLabel(action),
          onClick: runAction,
        },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          onClose: () => dismissNotificationKey(notificationKey),
          secondaryActionProps: {
            children: "Details",
            onClick: openProviderSettings,
          },
          secondaryActionVariant: "outline",
        },
      }),
    );
    activeToastRef.current = { key: notificationKey, toastId };
  }, [
    closeActiveToast,
    dismissNotificationKey,
    dismissedNotificationKeys,
    info,
    navigate,
    notificationKey,
  ]);

  return null;
}
