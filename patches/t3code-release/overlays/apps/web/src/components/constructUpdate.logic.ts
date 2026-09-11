import type {
  ConstructUpdateAction,
  ConstructUpdateInfo,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

import { planConstructProviderRows, type ConstructLinkedRemote } from "./constructInstances.logic";

/** The popup follows the current thread's remote, including that VM's own markers.
 * Host updates apply to this PC; VM offers require an unambiguous registry match. */
export function getConstructThreadUpdateInfo(
  info: ConstructUpdateInfo | null,
  remote: ConstructLinkedRemote | null,
): ConstructUpdateInfo | null {
  if (info === null || info.action === "update-construct") return info;
  if (remote === null) return null;
  const row = planConstructProviderRows({
    remotes: [remote],
    info,
    t3LatestByChannel: info.t3LatestByChannel,
  }).find((candidate) => candidate.id === remote.id && candidate.linked);
  if (!row || row.instanceName === null) return null;
  const instance = info.instances.find((candidate) => candidate.name === row.instanceName)!;
  return {
    ...info,
    vmName: instance.name,
    vmHost: instance.vmHost,
    provisionedCommit: row.provisionedCommit,
    provisionStale: row.provisionStale,
    t3LatestVersion: row.t3LatestVersion,
    t3UpdateAvailable: row.t3UpdateAvailable,
    action: row.provisionStale || row.t3UpdateAvailable ? "reprovision" : null,
  };
}

/**
 * Presentation helpers for Construct-managed updates (Construct-built Desktop
 * apps only; `state.construct` is absent everywhere else). The Desktop main
 * process decides WHAT to offer (ConstructUpdates.ts); this file decides how to
 * word it. Pure, so it unit-tests without React.
 */

export function getConstructUpdateInfo(
  state: DesktopUpdateState | null | undefined,
): ConstructUpdateInfo | null {
  return state?.construct ?? null;
}

/** Why nothing can be launched from this build right now (T3CODE_DISABLE_AUTO_UPDATE):
 *  the Construct facts are still shown, the controls are inert. */
export function getConstructDisabledReason(
  state: DesktopUpdateState | null | undefined,
): string | null {
  if (!state || state.construct === undefined || state.enabled) return null;
  return "Construct-managed updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting, so nothing can be launched from here.";
}

export function isConstructManagedUpdateState(
  state: DesktopUpdateState | null | undefined,
): boolean {
  return getConstructUpdateInfo(state) !== null;
}

export function getConstructUpdateActionLabel(action: ConstructUpdateAction): string {
  return action === "update-construct" ? "Update Construct" : "Reprovision VM";
}

export function getConstructUpdateActionVerb(action: ConstructUpdateAction): string {
  return action === "update-construct"
    ? "update Construct on this PC"
    : "reprovision the VM through Construct";
}

export function shortConstructCommit(commit: string | null): string | null {
  return commit === null ? null : commit.slice(0, 7);
}

/** The version pill next to the Construct entry: `main@dc44958`, or `main` when the
 *  installed commit is unknown. */
export function getConstructVersionLabel(info: ConstructUpdateInfo): string {
  const commit = shortConstructCommit(info.installedCommit);
  return commit === null ? info.ref : `${info.ref}@${commit}`;
}

export function getConstructUpdateHeadline(info: ConstructUpdateInfo): string {
  if (info.runningAction === "update-construct") return "Construct update running";
  if (info.runningAction === "reprovision") return "Construct reprovision running";
  if (info.action === "update-construct") return "Construct update available";
  if (info.action === "reprovision") {
    return info.t3UpdateAvailable && !info.provisionStale
      ? "T3 Code update available"
      : "VM reprovision pending";
  }
  if (info.error !== null) return "Construct update check failed";
  return "Construct is up to date";
}

/** One or two sentences under the headline: what changed and what the action does. */
export function getConstructUpdateDetail(info: ConstructUpdateInfo): string {
  if (info.runningAction !== null) {
    const title =
      info.runningAction === "update-construct" ? "Construct update" : "Construct reprovision";
    return info.runningAction === "reprovision"
      ? `Follow the "${title}" console window. When the reprovision installs a new T3 Code Desktop build, this app closes and reopens on its own; otherwise it picks the result up when the window closes.`
      : `Follow the "${title}" console window. This app picks the result up when the window closes; reprovision the VM afterwards to apply the update there.`;
  }
  if (info.action === "update-construct") {
    const latest = shortConstructCommit(info.latestCommit);
    const installed = shortConstructCommit(info.installedCommit) ?? "an unknown version";
    const change = `A newer Construct release (${latest}) is published; this PC has ${installed}.`;
    return `${change} Updating refreshes the Construct scripts and the VS Code control panel here; reprovision the VM afterwards to apply it there.`;
  }
  if (info.action === "reprovision") {
    const reasons: string[] = [];
    if (info.provisionStale) {
      const provisioned = shortConstructCommit(info.provisionedCommit) ?? "an older Construct";
      const installed = shortConstructCommit(info.installedCommit) ?? "a newer one";
      reasons.push(
        `VM "${info.vmName}" was provisioned with Construct ${provisioned}, but this PC has ${installed}.`,
      );
    }
    if (info.t3UpdateAvailable && info.t3LatestVersion !== null) {
      reasons.push(
        `T3 Code ${info.t3LatestVersion} is available upstream (this build is ${info.t3Version}).`,
      );
    }
    reasons.push(
      `Reprovisioning VM "${info.vmName}" applies the installed Construct, rebuilds the patched T3 Code and installs the new Desktop app silently.`,
    );
    return reasons.join(" ");
  }
  if (info.error !== null) return info.error;
  const parts = [`Construct ${getConstructVersionLabel(info)} is installed and provisioned`];
  parts.push(
    info.t3LatestVersion === null
      ? `this build is T3 Code ${info.t3Version}`
      : `T3 Code ${info.t3Version} is the newest release on its channel`,
  );
  return `${parts.join(", and ")}.`;
}

/** Sidebar pill tooltip. */
export function getConstructUpdateTooltip(info: ConstructUpdateInfo): string {
  const headline = getConstructUpdateHeadline(info);
  if (info.runningAction !== null) return `${headline}…`;
  if (info.action !== null) {
    return `${headline} — click to ${getConstructUpdateActionVerb(info.action)}.`;
  }
  if (info.error !== null) return `${headline}: ${info.error}`;
  return "Construct and T3 Code are up to date";
}

/** The About-section button caption. */
export function getConstructUpdateButtonLabel(info: ConstructUpdateInfo): string {
  if (info.runningAction !== null) return "Running…";
  if (info.action !== null) return getConstructUpdateActionLabel(info.action);
  return "Check for Updates";
}

/** Identity of an offer, for "show the popup once per offer". Excludes the published commit
 *  so every newly published release does not re-raise a dismissed prompt. */
export function getConstructUpdateNotificationKey(info: ConstructUpdateInfo): string | null {
  if (info.action === null || info.runningAction !== null) return null;
  return [
    "construct",
    info.action,
    ...(info.action === "reprovision" ? [info.vmName, info.vmHost] : []),
    info.installedCommit ?? "-",
    info.provisionedCommit ?? "-",
    info.t3UpdateAvailable ? (info.t3LatestVersion ?? "-") : "-",
  ].join(":");
}

export type ConstructLaunchOutcome =
  | { readonly kind: "started"; readonly action: ConstructUpdateAction }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "nothing" };

/** Interpret the `downloadUpdate` result of a Construct-managed build. */
export function getConstructLaunchOutcome(
  result: DesktopUpdateActionResult,
): ConstructLaunchOutcome {
  const info = getConstructUpdateInfo(result.state);
  if (info?.runningAction) return { kind: "started", action: info.runningAction };
  if (!result.accepted) return { kind: "nothing" };
  const message = result.state.message?.trim() || info?.error?.trim();
  return { kind: "failed", message: message || "The Construct script could not be started." };
}
