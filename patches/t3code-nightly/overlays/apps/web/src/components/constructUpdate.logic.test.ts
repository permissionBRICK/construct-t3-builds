import { describe, expect, it } from "vite-plus/test";
import type {
  ConstructUpdateInfo,
  ConstructInstanceInfo,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

import {
  constructReprovisionTargets,
  constructVmUpdateState,
  getConstructLaunchOutcome,
  getConstructUpdateButtonLabel,
  getConstructUpdateDetail,
  getConstructUpdateHeadline,
  getConstructUpdateTooltip,
  getConstructVersionLabel,
  withConstructReprovisionOffer,
} from "./constructUpdate.logic";
import { getDesktopUpdateButtonTooltip } from "./desktopUpdate.logic";

const INSTALLED = "dc44958114c7c43145c8f7830f6185235a1d752b";
const PROVISIONED = "b262652aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const current: ConstructUpdateInfo = {
  companionInstalled: false,
  repo: "permissionBRICK/The-Construct",
  ref: "main",
  scriptsDir: "C:\\Users\\alice\\AppData\\Local\\The-Construct\\x\\The-Construct-main",
  vmName: "agent-vm",
  vmHost: "agent-vm.mshome.net",
  instances: [],
  installedCommit: INSTALLED,
  provisionedCommit: INSTALLED,
  latestCommit: INSTALLED,
  constructUpdateAvailable: false,
  provisionStale: false,
  desktopVersion: "0.0.38-construct.bb8cb346",
  t3Version: "0.0.38",
  t3LatestVersion: "0.0.38",
  t3LatestByChannel: { latest: "0.0.38-construct.bb8cb346", nightly: null },
  t3UpdateAvailable: false,
  action: null,
  runningAction: null,
  checkedAt: "2026-09-03T10:00:00.000Z",
  error: null,
};

// The cast keeps this fixture valid across upstream versions: `omittedReleaseCount`
// is required on newer states and unknown on older ones.
const baseState = {
  enabled: true,
  status: "up-to-date",
  channel: "latest",
  currentVersion: "0.0.38-construct.bb8cb346",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
} as DesktopUpdateState;

describe("construct update presentation", () => {
  it("describes an up-to-date install", () => {
    expect(getConstructVersionLabel(current)).toBe("main@dc44958");
    expect(getConstructUpdateHeadline(current)).toBe("Construct is up to date");
    expect(getConstructUpdateDetail(current)).toBe("Up to date · T3 Code 0.0.38 (newest on its channel)");
    expect(getConstructUpdateTooltip(current)).toBe("Construct and T3 Code are up to date");
    expect(getConstructUpdateButtonLabel(current)).toBe("Check for Updates");
  });

  it("offers the published Construct release", () => {
    const info: ConstructUpdateInfo = {
      ...current,
      latestCommit: "f".repeat(40),
      constructUpdateAvailable: true,
      action: "update-construct",
    };
    expect(getConstructUpdateHeadline(info)).toBe("Construct update available");
    expect(getConstructUpdateDetail(info)).toBe(
      "A new Construct update is available. Click to install it on this PC. This doesn't interrupt your work in T3 Code.",
    );
    expect(getConstructUpdateTooltip(info)).toBe(
      "Construct update available — click to update Construct on this PC.",
    );
    expect(getConstructUpdateButtonLabel(info)).toBe("Update Construct");
    expect(getConstructUpdateDetail({ ...info, installedCommit: null })).toBe(getConstructUpdateDetail(info));
  });

  it("explains a pending reprovision and a T3 Code update", () => {
    const stale: ConstructUpdateInfo = {
      ...current,
      provisionedCommit: PROVISIONED,
      provisionStale: true,
      action: "reprovision",
    };
    expect(getConstructUpdateHeadline(stale)).toBe("VM reprovision pending");
    expect(getConstructUpdateDetail(stale)).toBe(
      'The latest Construct update has not yet been installed onto "agent-vm". Click to reprovision and update all your tools. This might interrupt your agents if they get an update too.',
    );
    expect(getConstructUpdateButtonLabel(stale)).toBe("Reprovision VM");

    const t3: ConstructUpdateInfo = {
      ...current,
      t3LatestVersion: "0.0.39",
      t3UpdateAvailable: true,
      action: "update-t3",
    };
    expect(getConstructUpdateHeadline(t3)).toBe("T3 Code update available");
    expect(getConstructUpdateDetail(t3)).toBe(
      "T3 Code 0.0.39 is available. Click to install it in this app and on the Construct VMs it is connected to, without a reprovision. Threads that are running stop and are told to continue.",
    );
    expect(getConstructUpdateButtonLabel(t3)).toBe("Update T3 Code");
    expect(getConstructUpdateTooltip(t3)).toBe(
      "T3 Code update available — click to update T3 Code in this app and on the connected Construct VMs.",
    );
    expect(getConstructUpdateHeadline({ ...t3, runningAction: "update-t3" })).toBe(
      "T3 Code update running",
    );

    // A pending reprovision updates T3 Code too, so the check offers that instead.
    const both: ConstructUpdateInfo = {
      ...stale,
      ...t3,
      provisionStale: true,
      provisionedCommit: PROVISIONED,
      action: "reprovision",
    };
    expect(getConstructUpdateHeadline(both)).toBe("VM reprovision pending");
    expect(getConstructUpdateDetail(both)).toBe(getConstructUpdateDetail(stale));
  });

  it("marks a running script and a failed check", () => {
    const running: ConstructUpdateInfo = {
      ...current,
      action: "reprovision",
      runningAction: "reprovision",
    };
    expect(getConstructUpdateHeadline(running)).toBe("Construct reprovision running");
    expect(getConstructUpdateTooltip(running)).toBe("Construct reprovision running…");
    expect(getConstructUpdateButtonLabel(running)).toBe("Running…");

    const failed: ConstructUpdateInfo = {
      ...current,
      error: "Could not check GitHub for Construct updates.",
    };
    expect(getConstructUpdateHeadline(failed)).toBe("Construct update check failed");
    expect(getConstructUpdateTooltip(failed)).toContain("Could not check GitHub");
  });

  it("routes the stock tooltip through the Construct wording when present", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "Construct main",
      construct: {
        ...current,
        latestCommit: "f".repeat(40),
        constructUpdateAvailable: true,
        action: "update-construct",
      },
    };
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Construct update available — click to update Construct on this PC.",
    );
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toBe("Update 1.1.0 ready to download");
  });

  it("reads the launch outcome from the download result", () => {
    const started: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "downloading",
        construct: { ...current, action: "reprovision", runningAction: "reprovision" },
      },
    };
    expect(getConstructLaunchOutcome(started)).toEqual({ kind: "started", action: "reprovision" });

    const failed: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        message: "Update-T3Code.ps1 was not found in C:\\x.",
        errorContext: "download",
        construct: {
          ...current,
          action: "reprovision",
          error: "Update-T3Code.ps1 was not found in C:\\x.",
        },
      },
    };
    expect(getConstructLaunchOutcome(failed)).toEqual({
      kind: "failed",
      message: "Update-T3Code.ps1 was not found in C:\\x.",
    });

    expect(
      getConstructLaunchOutcome({
        accepted: false,
        completed: false,
        state: { ...baseState, construct: current },
      }),
    ).toEqual({ kind: "nothing" });
  });
});

describe("the one Update of the new Construct", () => {
  const agentView = {
    source: "agent" as const,
    version: "1.4.0",
    available: "1.5.0",
    vms: [{ name: "dev", version: "abcdef1", host: false }],
    running: false,
    parts: [],
  };
  const agent: ConstructUpdateInfo = {
    ...current,
    scriptsDir: null,
    ref: "1.4.0",
    action: "update-everything",
    everything: agentView,
  };

  it("names the new version and says what Update does", () => {
    expect(getConstructUpdateHeadline(agent)).toBe("Construct 1.5.0 available");
    expect(getConstructUpdateButtonLabel(agent)).toBe("Update");
    expect(getConstructUpdateDetail(agent)).toContain("this PC, the hosts you administer and your VMs");
    expect(getConstructUpdateTooltip(agent)).toBe(
      "Construct 1.5.0 available — click to update everything of yours in the background.",
    );
    const vmOnly = { ...agent, everything: { ...agentView, available: null } };
    expect(getConstructUpdateHeadline(vmOnly)).toBe("Construct abcdef1 available");
  });

  it("shows a running run's part, a failure, and nothing when current", () => {
    const running = {
      ...agent,
      runningAction: "update-everything" as const,
      everything: {
        ...agentView,
        running: true,
        parts: [{ part: "engine" as const, name: "home-host", state: "running" as const, detail: "Updating to 2.0.0" }],
      },
    };
    expect(getConstructUpdateHeadline(running)).toBe("Construct update running");
    expect(getConstructUpdateDetail(running)).toBe("Updating in the background: home-host (Updating to 2.0.0).");
    const failed = { ...agent, action: null, error: "home-host: the host update failed" };
    expect(getConstructUpdateDetail(failed)).toBe("home-host: the host update failed");
    const done = { ...agent, action: null, everything: { ...agentView, available: null, vms: [] } };
    expect(getConstructUpdateDetail(done)).toBe("Up to date · Construct 1.4.0 · T3 Code 0.0.38");
  });

  it("is the VM's own update in a browser", () => {
    expect(constructVmUpdateState(null, "0.1.10")).toBeNull();
    expect(
      constructVmUpdateState({ available: false, running: false, version: null, host: false, appliedCommit: "0123456" }, "0.1.10"),
    ).toBeNull();
    const offer = constructVmUpdateState(
      { available: true, running: false, version: "2.1.0", host: true, appliedCommit: "0123456" },
      "0.1.10",
    )!;
    expect(offer.status).toBe("available");
    expect(offer.construct?.action).toBe("update-everything");
    expect(offer.construct?.everything?.source).toBe("vm");
    expect(getDesktopUpdateButtonTooltip(offer)).toBe(
      "Construct 2.1.0 available — click to update everything of yours in the background.",
    );
    expect(getConstructUpdateDetail(offer.construct!)).toContain("this VM and its host");
    const running = constructVmUpdateState(
      { available: true, running: true, version: "2.1.0", host: true, appliedCommit: "0123456" },
      "0.1.10",
    )!;
    expect(running.status).toBe("downloading");
    expect(running.construct?.action).toBeNull();
    expect(running.construct?.runningAction).toBe("update-everything");
  });
});

describe("the old Construct's reprovision through the one control", () => {
  const vm = (name: string, port: number, provisionedCommit: string): ConstructInstanceInfo => ({
    name,
    vmHost: `${name}.mshome.net`,
    publicHost: null,
    hostAlias: name,
    isDefault: name === "agent-vm",
    provisionedCommit,
    channel: "latest",
    t3Port: port,
    t3Enabled: true,
    t3BaseUrl: null,
    t3Link: null,
  });
  const info: ConstructUpdateInfo = {
    ...current,
    instances: [vm("agent-vm", 5178, INSTALLED), vm("dev", 5179, PROVISIONED), vm("idle", 5180, PROVISIONED)],
  };
  const remotes = [{ id: "env-dev", baseUrl: "https://dev.mshome.net:5179", connected: true }];

  it("targets the default VM when it is behind and every linked VM that is behind", () => {
    expect(constructReprovisionTargets(info, remotes)).toEqual(["dev"]);
    expect(constructReprovisionTargets({ ...info, provisionStale: true }, remotes)).toEqual(["agent-vm", "dev"]);
    expect(constructReprovisionTargets(info, [])).toEqual([]);
  });

  it("offers it in the control when only a linked VM is behind", () => {
    const state = { ...baseState, construct: info };
    const offered = withConstructReprovisionOffer(state, remotes)!;
    expect(offered.status).toBe("available");
    expect(offered.construct?.action).toBe("reprovision");
    expect(withConstructReprovisionOffer(state, [])).toBe(state);
    expect(withConstructReprovisionOffer({ ...state, enabled: false }, remotes)?.construct?.action).toBeNull();
    const running = { ...state, construct: { ...info, runningAction: "update-t3" as const } };
    expect(withConstructReprovisionOffer(running, remotes)).toBe(running);
  });
});
