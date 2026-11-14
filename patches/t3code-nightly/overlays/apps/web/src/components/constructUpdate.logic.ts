import type {
  ConstructEverythingView,
  ConstructUpdateAction,
  ConstructUpdateInfo,
  ConstructVmUpdate,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

import { planConstructProviderRows, type ConstructLinkedRemote } from "./constructInstances.logic";

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
  if (action === "update-everything") return "Update";
  if (action === "update-construct") return "Update Construct";
  return action === "update-t3" ? "Update T3 Code" : "Reprovision VM";
}

export function getConstructUpdateActionVerb(action: ConstructUpdateAction): string {
  if (action === "update-everything") return "update everything of yours in the background";
  if (action === "update-construct") return "update Construct on this PC";
  return action === "update-t3"
    ? "update T3 Code in this app and on the connected Construct VMs"
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
  if (info.runningAction === "update-everything") return "Construct update running";
  if (info.runningAction === "update-construct") return "Construct update running";
  if (info.runningAction === "reprovision") return "Construct reprovision running";
  if (info.runningAction === "update-t3") return "T3 Code update running";
  if (info.action === "update-everything") {
    const offer = constructEverythingOffer(info);
    return offer === null ? "Construct update available" : `${offer} available`;
  }
  if (info.action === "update-construct") return "Construct update available";
  if (info.action === "update-t3") return "T3 Code update available";
  if (info.action === "reprovision") return "VM reprovision pending";
  if (info.error !== null) return info.everything === undefined ? "Construct update check failed" : "Construct update failed";
  return "Construct is up to date";
}

/** One or two sentences under the headline: what changed and what the action does. */
export function getConstructUpdateDetail(info: ConstructUpdateInfo): string {
  if (info.everything !== undefined) return getConstructEverythingDetail(info, info.everything);
  if (info.runningAction !== null) {
    return info.runningAction === "update-construct"
      ? "Running in a console window. The result shows up here when it closes."
      : "Running in a console window. The app restarts by itself if a new Desktop build is installed.";
  }
  if (info.action === "update-construct") {
    return "A new Construct update is available. Click to install it on this PC. This doesn't interrupt your work in T3 Code.";
  }
  if (info.action === "update-t3") {
    return `T3 Code ${info.t3LatestVersion ?? "update"} is available. Click to install it in this app and on the Construct VMs it is connected to, without a reprovision. Threads that are running stop and are told to continue.`;
  }
  if (info.action === "reprovision") {
    return `The latest Construct update has not yet been installed onto "${info.vmName}". Click to reprovision and update all your tools. This might interrupt your agents if they get an update too.`;
  }
  if (info.error !== null) return info.error;
  return info.t3LatestVersion === null
    ? `Up to date · T3 Code ${info.t3Version}`
    : `Up to date · T3 Code ${info.t3Version} (newest on its channel)`;
}

/** What the one Update offers: this device's release, a host's, or a VM's payload. */
export function constructEverythingOffer(info: ConstructUpdateInfo): string | null {
  const view = info.everything;
  if (view === undefined) return null;
  if (view.available !== null) return `Construct ${view.available}`;
  const named = view.vms.find((vm) => vm.host && vm.version !== null) ?? view.vms.find((vm) => vm.version !== null);
  if (named !== undefined) return `Construct ${named.version}`;
  if (info.t3UpdateAvailable && info.t3LatestVersion !== null) return `T3 Code ${info.t3LatestVersion}`;
  return view.vms.length > 0 ? "Construct update" : null;
}

function getConstructEverythingDetail(info: ConstructUpdateInfo, view: ConstructEverythingView): string {
  if (view.running) {
    const active = view.parts.find((part) => part.state === "running");
    if (view.source === "vm") return "The VM is updating. T3 Code restarts with it and continues your threads.";
    return active === undefined
      ? "Updating in the background."
      : `Updating in the background: ${active.name}${active.detail === null ? "" : ` (${active.detail})`}.`;
  }
  if (info.action === "update-everything") {
    return view.source === "vm"
      ? `Click Update to update this VM${view.vms.some((vm) => vm.host) ? " and its host" : ""} in the background. T3 Code restarts with it and continues your threads.`
      : "Click Update to update this PC, the hosts you administer and your VMs in the background. T3 Code restarts with them and continues your threads.";
  }
  if (info.error !== null) return info.error;
  return `Up to date · Construct ${view.version} · T3 Code ${info.t3Version}`;
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

/** The update control's tooltip with nothing on offer: a failed check or update, else the check. */
export function getConstructIdleTooltip(info: ConstructUpdateInfo): string {
  return info.error === null ? "Check for Construct and T3 Code updates" : getConstructUpdateTooltip(info);
}

/** The About-section button caption. */
export function getConstructUpdateButtonLabel(info: ConstructUpdateInfo): string {
  if (info.runningAction !== null) return "Running…";
  if (info.action !== null) return getConstructUpdateActionLabel(info.action);
  return "Check for Updates";
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

/**
 * The VMs the control's Reprovision runs on: the default VM when it is behind (offered even
 * before any remote is linked), and every linked VM that is behind. One console runs them
 * one after another. Pure.
 */
export function constructReprovisionTargets(
  info: ConstructUpdateInfo,
  remotes: ReadonlyArray<ConstructLinkedRemote>,
): ReadonlyArray<string> {
  const names = new Set<string>(info.provisionStale ? [info.vmName] : []);
  for (const row of planConstructProviderRows({ remotes, info, t3LatestByChannel: info.t3LatestByChannel })) {
    if (row.linked && row.provisionStale && row.instanceName !== null) names.add(row.instanceName);
  }
  return [...names];
}

/** The old Construct's state with an offer for linked VMs that are behind while the default VM
 *  is current (the Providers rows used to offer those one by one): a reprovision, else a T3
 *  Code update of the connected VMs. Pure. */
export function withConstructReprovisionOffer(
  state: DesktopUpdateState | null,
  remotes: ReadonlyArray<ConstructLinkedRemote>,
): DesktopUpdateState | null {
  const info = state?.construct;
  if (state === null || info === undefined || info.everything !== undefined || !state.enabled) return state;
  if (info.action !== null || info.runningAction !== null || info.scriptsDir === null) return state;
  const reprovision = constructReprovisionTargets(info, remotes).length > 0;
  const t3Behind = planConstructProviderRows({ remotes, info, t3LatestByChannel: info.t3LatestByChannel }).some(
    (row) => row.linked && row.t3UpdateAvailable && row.instanceName !== null,
  );
  if (!reprovision && !t3Behind) return state;
  return {
    ...state,
    status: "available",
    availableVersion: reprovision ? "Construct reprovision" : "T3 Code",
    message: null,
    errorContext: null,
    construct: { ...info, action: reprovision ? "reprovision" : "update-t3" },
  };
}

/**
 * The update control's state in a browser (no Desktop app): the VM this page is served by
 * reports its own Construct update. Null when it has none to show. Pure.
 */
export function constructVmUpdateState(
  vm: ConstructVmUpdate | null,
  currentVersion: string,
): DesktopUpdateState | null {
  if (vm === null || (!vm.available && !vm.running)) return null;
  const everything: ConstructEverythingView = {
    source: "vm",
    version: vm.appliedCommit ?? "",
    available: null,
    vms: [{ name: "this VM", version: vm.version, host: vm.host }],
    running: vm.running,
    parts: [],
  };
  const action = vm.running ? null : ("update-everything" as const);
  const offer = vm.version === null ? "Construct update" : `Construct ${vm.version}`;
  return {
    enabled: true,
    status: vm.running ? "downloading" : "available",
    channel: "latest",
    currentVersion,
    hostArch: "other",
    appArch: "other",
    runningUnderArm64Translation: false,
    availableVersion: offer,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    construct: {
      companionInstalled: false,
      repo: "",
      ref: everything.version,
      scriptsDir: null,
      vmName: "",
      vmHost: "",
      instances: [],
      installedCommit: null,
      provisionedCommit: null,
      latestCommit: null,
      constructUpdateAvailable: vm.available,
      provisionStale: false,
      desktopVersion: currentVersion,
      t3Version: currentVersion,
      t3LatestVersion: null,
      t3UpdateAvailable: false,
      t3LatestByChannel: { latest: null, nightly: null },
      action,
      runningAction: vm.running ? "update-everything" : null,
      checkedAt: null,
      error: null,
      everything,
    },
  };
}
