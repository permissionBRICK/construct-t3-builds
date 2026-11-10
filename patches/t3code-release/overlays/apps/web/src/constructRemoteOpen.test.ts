import { buildRemoteOpenUrl, EnvironmentId, type ConstructInstanceInfo, type ConstructUpdateInfo } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pairedEntry, withLearnedLanRoute } from "./components/constructInstances.test-fixtures";
import { constructSshTargetFor } from "./constructRemoteOpen";
import { resolveRemoteOpenState } from "./remoteOpen";

const HAUS = EnvironmentId.make("env-haus");
// What a service-managed VM's T3 advertises: only its mDNS name, unreachable from another network.
const ADVERTISED = [{ kind: "mdns", host: "haus-vm.local", username: "root" }] as const;

function instance(over: Partial<ConstructInstanceInfo> & { name: string }): ConstructInstanceInfo {
  return {
    vmHost: `${over.name}.mshome.net`,
    publicHost: null,
    hostAlias: over.name,
    isDefault: false,
    provisionedCommit: null,
    channel: null,
    t3Port: null,
    t3Enabled: null,
    t3BaseUrl: null,
    t3Link: null,
    ...over,
  };
}

function info(instances: ReadonlyArray<ConstructInstanceInfo>): ConstructUpdateInfo {
  return { instances } as unknown as ConstructUpdateInfo;
}

const AGENT = instance({ name: "agent-vm", isDefault: true });
const HAUS_VM = instance({
  name: "haus-vm",
  vmHost: "construct.haus.example.net",
  publicHost: "haus-vm.haus.example.net",
  hostAlias: "haus-ssh",
});

function editorUrl(entry: ReturnType<typeof pairedEntry>, instances: ConstructUpdateInfo | null) {
  const state = resolveRemoteOpenState({
    target: entry.target,
    sshTarget: constructSshTargetFor(String(HAUS), entry, instances),
    remoteOpenTargets: ADVERTISED,
    isDesktopRenderer: true,
  });
  if (state.mode !== "remote-links") return state.mode;
  return buildRemoteOpenUrl({
    editor: "vscode",
    host: state.host.host,
    ...(state.host.username === undefined ? {} : { username: state.host.username }),
    absolutePath: "/root/repos/construct",
  });
}

describe("constructSshTargetFor", () => {
  it("opens a linked Construct VM through this PC's ssh alias for it", () => {
    const entry = pairedEntry(HAUS, "https://haus-vm.haus.example.net/");
    expect(constructSshTargetFor(String(HAUS), entry, info([AGENT, HAUS_VM]))).toEqual({
      alias: "haus-ssh",
      username: null,
    });
    // No user part: the config block's User applies and the link is the Companion's own.
    expect(editorUrl(entry, info([AGENT, HAUS_VM]))).toBe(
      "vscode://vscode-remote/ssh-remote+haus-ssh/root/repos/construct",
    );
  });

  it("matches by the paired address, also behind a learned LAN route", () => {
    const entry = withLearnedLanRoute(pairedEntry(HAUS, "https://haus-vm.haus.example.net/"), "https://10.0.6.20:5177/");
    expect(constructSshTargetFor(String(HAUS), entry, info([AGENT, HAUS_VM]))?.alias).toBe("haus-ssh");
  });

  it("matches a remote paired through a proxy by the instance's link marker", () => {
    const entry = pairedEntry(HAUS, "https://t3.proxy.example.org/");
    const marked = instance({
      ...HAUS_VM,
      t3Link: { status: "linked", at: "2026-11-10T12:00:00.000Z", environmentId: "env-haus", baseUrl: null, error: null },
    });
    expect(constructSshTargetFor(String(HAUS), entry, info([AGENT, HAUS_VM]))).toBeNull();
    expect(constructSshTargetFor(String(HAUS), entry, info([AGENT, marked]))?.alias).toBe("haus-ssh");
  });

  it("leaves other servers, browsers and an unread instance list to upstream's advertised host", () => {
    const entry = pairedEntry(HAUS, "https://other.example.net/");
    expect(constructSshTargetFor(String(HAUS), entry, info([AGENT, HAUS_VM]))).toBeNull();
    expect(constructSshTargetFor(String(HAUS), pairedEntry(HAUS, "https://haus-vm.haus.example.net/"), null)).toBeNull();
    expect(editorUrl(entry, info([AGENT, HAUS_VM]))).toBe(
      "vscode://vscode-remote/ssh-remote+root%40haus-vm.local/root/repos/construct",
    );
  });
});
