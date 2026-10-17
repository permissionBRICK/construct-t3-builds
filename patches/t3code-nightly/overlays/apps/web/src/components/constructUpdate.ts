import type { ConstructUpdateInfo, DesktopBridge } from "@t3tools/contracts";

import { constructConnectedInstanceNames, type ConstructLinkedRemote } from "./constructInstances.logic";
import { getConstructLaunchOutcome, getConstructUpdateActionLabel } from "./constructUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ConstructUpdateBridge = Pick<DesktopBridge, "downloadUpdate" | "reprovisionConstructInstance">;

/** The remotes the app is linked to, kept current by the always-mounted update popup, so
 *  every control that launches a T3 Code update sees the same connections. */
let linkedRemotes: ReadonlyArray<ConstructLinkedRemote> = [];

export function setConstructLinkedRemotes(remotes: ReadonlyArray<ConstructLinkedRemote>): void {
  linkedRemotes = remotes;
}

/**
 * Run the Construct action the Desktop app currently offers (`downloadUpdate` is the
 * stock IPC for host updates). A reprovision passes the displayed name; a T3 Code update
 * is for this app and every Construct VM it is connected to, so it names those. Shared by
 * the sidebar pill, the About section, the update popup and the Providers entry so they
 * launch and report identically. Resolves true when a script was started.
 */
export async function startConstructUpdate(
  bridge: ConstructUpdateBridge,
  info: ConstructUpdateInfo,
): Promise<boolean> {
  if (info.action === null || info.runningAction !== null) return false;
  const actionLabel = getConstructUpdateActionLabel(info.action);
  const targets =
    info.action === "update-t3" ? constructConnectedInstanceNames(linkedRemotes, info.instances) : [];
  if (info.action === "update-t3" && targets.length === 0) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not start: ${actionLabel}`,
        description:
          "No Construct VM is connected. Start the VM you want to update, wait until T3 Code is connected to it, then try again.",
      }),
    );
    return false;
  }
  try {
    const outcome = getConstructLaunchOutcome(
      info.action === "update-construct"
        ? await bridge.downloadUpdate()
        : info.action === "update-t3"
          ? await bridge.reprovisionConstructInstance(targets, "update-t3")
          : await bridge.reprovisionConstructInstance(info.vmName, info.action),
    );
    if (outcome.kind === "started") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: `${actionLabel} started`,
          description:
            outcome.action === "update-construct"
              ? "Follow the Construct update console window. Reprovision the VM afterwards to apply the update there."
              : `Follow the ${outcome.action === "update-t3" ? `T3 Code update console window (${targets.join(", ")})` : "Construct reprovision console window"}. When it installs a new T3 Code Desktop build, this app closes and reopens on its own.`,
        }),
      );
      return true;
    }
    if (outcome.kind === "failed") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not start: ${actionLabel}`,
          description: outcome.message,
        }),
      );
    }
    return false;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not start: ${actionLabel}`,
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
    return false;
  }
}
