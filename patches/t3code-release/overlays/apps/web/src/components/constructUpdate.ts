import type { ConstructUpdateInfo, DesktopBridge } from "@t3tools/contracts";

import { constructConnectedInstanceNames, type ConstructLinkedRemote } from "./constructInstances.logic";
import {
  constructReprovisionTargets,
  getConstructLaunchOutcome,
  getConstructUpdateActionLabel,
} from "./constructUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ConstructUpdateBridge = Pick<DesktopBridge, "downloadUpdate" | "reprovisionConstructInstance">;

/** The remotes the app is linked to, kept current by the always-mounted auto-link, so every
 *  control that launches a Construct action sees the same connections. */
let linkedRemotes: ReadonlyArray<ConstructLinkedRemote> = [];

export function setConstructLinkedRemotes(remotes: ReadonlyArray<ConstructLinkedRemote>): void {
  linkedRemotes = remotes;
}

/** In a browser: starts the VM's own update (set by the update control's state hook). */
let vmUpdateRunner: (() => Promise<{ readonly started: boolean; readonly message: string | null }>) | null = null;

export function setConstructVmUpdateRunner(runner: typeof vmUpdateRunner): void {
  vmUpdateRunner = runner;
}

function failed(actionLabel: string, description: string): false {
  toastManager.add(stackedThreadToast({ type: "error", title: `Could not start: ${actionLabel}`, description }));
  return false;
}

/**
 * Run the Construct action the update control offers. With the new Construct that is the one
 * Update: in the Desktop app the device agent updates everything of the user's in the
 * background (`downloadUpdate`, the stock IPC); in a browser the VM updates itself. Without
 * it, the old Construct's scripts run: a Construct update for this PC, a reprovision of the
 * VMs that are behind, or a T3 Code update of this app and every Construct VM it is
 * connected to. Shared by the sidebar control and the Providers entry. Resolves true when
 * something was started.
 */
export async function startConstructUpdate(
  bridge: ConstructUpdateBridge | undefined,
  info: ConstructUpdateInfo,
): Promise<boolean> {
  if (info.action === null || info.runningAction !== null) return false;
  const action = info.action;
  const actionLabel = getConstructUpdateActionLabel(action);
  try {
    if (action === "update-everything" && info.everything?.source === "vm") {
      const run = vmUpdateRunner;
      if (run === null) return failed(actionLabel, "This page cannot reach its VM.");
      const outcome = await run();
      if (!outcome.started) return failed(actionLabel, outcome.message ?? "The VM did not start its update.");
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Construct update started",
          description: "The VM updates in the background. T3 Code restarts with it and continues your threads.",
        }),
      );
      return true;
    }
    if (bridge === undefined) return false;
    const targets =
      action === "update-t3"
        ? constructConnectedInstanceNames(linkedRemotes, info.instances)
        : action === "reprovision"
          ? constructReprovisionTargets(info, linkedRemotes)
          : [];
    if (action === "update-t3" && targets.length === 0) {
      return failed(
        actionLabel,
        "No Construct VM is connected. Start the VM you want to update, wait until T3 Code is connected to it, then try again.",
      );
    }
    if (action === "reprovision" && targets.length === 0) return false;
    const outcome = getConstructLaunchOutcome(
      action === "update-construct" || action === "update-everything"
        ? await bridge.downloadUpdate()
        : await bridge.reprovisionConstructInstance(targets, action),
    );
    if (outcome.kind === "started") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: `${actionLabel} started`,
          description:
            outcome.action === "update-everything"
              ? "Construct updates this PC, the hosts you administer and your VMs in the background."
              : outcome.action === "update-construct"
                ? "Follow the Construct update console window. Reprovision the VM afterwards to apply the update there."
                : `Follow the ${outcome.action === "update-t3" ? "T3 Code update" : "Construct reprovision"} console window (${targets.join(", ")}). When it installs a new T3 Code Desktop build, this app closes and reopens on its own.`,
        }),
      );
      return true;
    }
    if (outcome.kind === "failed") return failed(actionLabel, outcome.message);
    return false;
  } catch (error) {
    return failed(actionLabel, error instanceof Error ? error.message : "An unexpected error occurred.");
  }
}
