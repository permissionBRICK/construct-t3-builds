import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  sessionHasLegacyPermissions,
  type ConstructInstanceInfo,
  type ConstructUpdateInfo,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const LEGACY = { authenticated: true, permissions: ["orchestration:operate", "orchestration:read"] };
const CURRENT = { authenticated: true, permissions: ["orchestration:operate", "filesystem:read"] };

const state = vi.hoisted(() => ({
  session: { _tag: "Success", waiting: false, value: {} as unknown },
  environments: [] as unknown[],
  info: null as unknown,
  store: new Set<string>(),
  // Upstream's permission notices, subscribed to the legacy-session environments.
  notices: null as null | ((environments: ReadonlyArray<{ environmentId: string; label: string }>) => void),
  add: vi.fn((_toast: { title: string }) => "toast"),
  close: vi.fn(),
  connectPairing: vi.fn(async (_input: unknown): Promise<unknown> => null),
  bridge: {
    linkConstructInstance: vi.fn(async (_name: string) => ({
      ok: true as const,
      pairUrl: "https://t3haus.example.net:8443/pair#token=NEWTOKEN",
      scopes: "administrative" as const,
    })),
    recordConstructInstanceT3Link: vi.fn(async () => true),
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.session }));
vi.mock("../state/session", () => ({ environmentSession: { sessionStateAtom: () => null } }));
vi.mock("../state/presentation", () => ({ environmentSummaries: { identitiesAtom: null } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: NonNullable<typeof state.notices>, options?: { immediate?: boolean }) => {
      state.notices = listener;
      if (options?.immediate) listener([]);
      return () => void (state.notices = null);
    },
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../state/desktopUpdate", () => ({ useDesktopUpdateState: () => null }));
vi.mock("./constructUpdate.logic", () => ({ getConstructUpdateInfo: () => state.info }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.connectPairing }));
vi.mock("~/connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => state.store.has(key),
  setLocalStorageItem: (key: string) => void state.store.add(key),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
  stackedThreadToast: (toast: unknown) => toast,
}));
import { ConstructAutoLink } from "./ConstructAutoLink";
import { pairedEntry, withLearnedLanRoute } from "./constructInstances.test-fixtures";
import { startPermissionUpdateNotices } from "./PermissionUpdateNotice";

const HAUS: ConstructInstanceInfo = {
  name: "haus-vm",
  vmHost: "haus-vm.mshome.net",
  publicHost: "standpc.example.net",
  hostAlias: "haus-vm",
  isDefault: false,
  provisionedCommit: null,
  channel: "latest",
  t3Port: 2301,
  t3Enabled: true,
  t3BaseUrl: "https://standpc.example.net:2301",
  t3Link: null,
};

function info(instances: ReadonlyArray<ConstructInstanceInfo>): ConstructUpdateInfo {
  return {
    companionInstalled: true,
    repo: "permissionBRICK/The-Construct",
    ref: "main",
    scriptsDir: "C:\\scripts",
    vmName: "haus-vm",
    vmHost: "haus-vm.mshome.net",
    instances: [...instances],
    installedCommit: null,
    provisionedCommit: null,
    latestCommit: null,
    constructUpdateAvailable: false,
    provisionStale: false,
    desktopVersion: "0.1.0-construct.bb8cb346",
    t3Version: "0.1.0",
    t3LatestVersion: "0.1.0",
    t3LatestByChannel: { latest: "0.1.0-construct.bb8cb346", nightly: null },
    t3UpdateAvailable: false,
    action: null,
    runningAction: null,
    checkedAt: "now",
    error: null,
  };
}

function environment(
  environmentId: string,
  pairedAt: string,
  shape: (entry: ConnectionCatalogEntry) => ConnectionCatalogEntry = (entry) => entry,
) {
  const entry = shape(pairedEntry(EnvironmentId.make(environmentId), pairedAt));
  const profile = entry.profile._tag === "Some" && entry.profile.value._tag === "BearerConnectionProfile" ? entry.profile.value : null;
  return {
    environmentId,
    label: environmentId,
    displayUrl: profile?.httpBaseUrl ?? null,
    entry,
    connection: { phase: "connected" },
  };
}

// The component renders nothing, so React DOM only needs a container to attach to
// (and `window.HTMLIFrameElement`, which its commit phase checks); the web unit tests
// run in Node without a DOM.
const container = {
  nodeType: 1,
  tagName: "DIV",
  namespaceURI: "http://www.w3.org/1999/xhtml",
  addEventListener() {},
  removeEventListener() {},
  ownerDocument: null,
};
let root: Root | undefined;
let stopNotices: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  state.store.clear();
  state.session = { _tag: "Success", waiting: false, value: LEGACY };
  state.environments = [environment("env-haus", "https://standpc.example.net:2301/")];
  state.info = info([HAUS]);
  state.connectPairing.mockImplementation(async () => AsyncResult.success("env-haus"));
  vi.stubGlobal("window", { desktopBridge: state.bridge, HTMLIFrameElement: class {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  stopNotices?.();
  stopNotices = undefined;
  vi.unstubAllGlobals();
});

// The app's order: upstream's notices start with the router, the root mounts
// ConstructAutoLink, then the sessions settle. Upstream's subscription asks at once,
// before React renders the settled session.
async function render() {
  const settled = state.session;
  state.session = { ...settled, waiting: true };
  stopNotices = startPermissionUpdateNotices({ navigate: vi.fn() } as never);
  await act(async () => {
    root = createRoot(container as never);
    root.render(<ConstructAutoLink />);
  });
  state.session = settled;
  state.notices?.(
    sessionHasLegacyPermissions(settled.value as never)
      ? state.environments.map((entry) => {
          const { environmentId, label } = entry as { environmentId: string; label: string };
          return { environmentId, label };
        })
      : [],
  );
  await act(async () => root!.render(<ConstructAutoLink />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const titles = () => state.add.mock.calls.map(([toast]) => toast.title);

it("pairs a Construct VM with the old permissions again instead of asking the user", async () => {
  await render();
  expect(state.bridge.linkConstructInstance).toHaveBeenCalledTimes(1);
  expect(state.bridge.linkConstructInstance).toHaveBeenCalledWith("haus-vm");
  expect(state.connectPairing).toHaveBeenCalledTimes(1);
  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://standpc.example.net:2301/",
    pairingCode: "NEWTOKEN",
    expectedEnvironmentId: "env-haus",
  });
  expect(titles()).toEqual(["Updated permissions for haus-vm"]);
  expect(state.store.has("t3code:permission-update:v1:env-haus")).toBe(true);
});

it("finds the VM behind the user's own proxy by the environment its link recorded", async () => {
  state.environments = [environment("env-haus", "https://t3haus.home.example.net:8443/")];
  state.info = info([
    {
      ...HAUS,
      t3Link: { status: "linked", at: "2026-09-04T21:52:00Z", environmentId: "env-haus", baseUrl: "https://standpc.example.net:2301", error: null },
    },
  ]);
  await render();
  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://t3haus.home.example.net:8443/",
    pairingCode: "NEWTOKEN",
    expectedEnvironmentId: "env-haus",
  });
  expect(titles()).toEqual(["Updated permissions for haus-vm"]);
});

it("redeems the token at the paired route, not at a learned LAN route saved ahead of it", async () => {
  state.environments = [
    environment("env-haus", "https://standpc.example.net:2301/", (entry) => withLearnedLanRoute(entry, "https://172.30.1.5:5177/")),
  ];
  // Linked by the auto-link earlier, as such a VM is.
  state.info = info([
    {
      ...HAUS,
      t3Link: { status: "linked", at: "2026-09-04T21:52:00Z", environmentId: "env-haus", baseUrl: "https://standpc.example.net:2301", error: null },
    },
  ]);
  await render();
  expect(state.connectPairing).toHaveBeenCalledTimes(1);
  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://standpc.example.net:2301/",
    pairingCode: "NEWTOKEN",
    expectedEnvironmentId: "env-haus",
  });
});

it("tries once per app session and reports a failure", async () => {
  state.bridge.linkConstructInstance.mockResolvedValueOnce({ ok: false, error: "ssh failed." } as never);
  await render();
  await act(async () => root!.render(<ConstructAutoLink />));
  expect(state.bridge.linkConstructInstance).toHaveBeenCalledTimes(1);
  expect(state.connectPairing).not.toHaveBeenCalled();
  expect(titles()).toEqual(["Could not update permissions for haus-vm"]);
});

it("leaves a server this PC does not manage to upstream's notice", async () => {
  state.environments = [environment("env-other", "https://elsewhere.example.com/")];
  state.info = info([]);
  await render();
  expect(state.bridge.linkConstructInstance).not.toHaveBeenCalled();
  expect(titles()).toEqual(["Permissions have changed for env-other"]);
});

it("does nothing for a session with the current permissions", async () => {
  state.session = { _tag: "Success", waiting: false, value: CURRENT };
  await render();
  expect(state.bridge.linkConstructInstance).not.toHaveBeenCalled();
  expect(state.add).not.toHaveBeenCalled();
});
