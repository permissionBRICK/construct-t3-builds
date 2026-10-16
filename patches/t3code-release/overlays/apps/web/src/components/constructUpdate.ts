import type { ConstructUpdateInfo, DesktopBridge } from "@t3tools/contracts";

import { getConstructLaunchOutcome, getConstructUpdateActionLabel } from "./constructUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ConstructUpdateBridge = Pick<DesktopBridge, "downloadUpdate" | "reprovisionConstructInstance">;

/**
 * Run the Construct action the Desktop app currently offers (`downloadUpdate` is the
 * stock IPC for host updates; a reprovision or T3 Code update always passes the displayed
 * name and the action). Shared by the
 * sidebar pill, the About section, the update popup and the Providers entry so they
 * launch and report identically. Resolves true when a script was started.
 */
export async function startConstructUpdate(
  bridge: ConstructUpdateBridge,
  info: ConstructUpdateInfo,
): Promise<boolean> {
  if (info.action === null || info.runningAction !== null) return false;
  const actionLabel = getConstructUpdateActionLabel(info.action);
  try {
    const outcome = getConstructLaunchOutcome(
      info.action === "update-construct"
        ? await bridge.downloadUpdate()
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
              : `Follow the ${outcome.action === "update-t3" ? "T3 Code update" : "Construct reprovision"} console window. When it installs a new T3 Code Desktop build, this app closes and reopens on its own.`,
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
