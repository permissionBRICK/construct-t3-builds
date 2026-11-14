// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a fake device agent on a
// loopback port and fake token files; no real agent, engine or network.
import { afterAll, assert, beforeAll, beforeEach, describe, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import type { ConstructUpdateInfo } from "@t3tools/contracts";

import { checkConstructUpdates, type ConstructFileSystem } from "../updates/ConstructUpdates.ts";
import {
  constructAgentEndpointPath,
  constructAgentOfferLabel,
  constructAgentRunFailure,
  createConstructAgentEventParser,
  decideConstructAgentApproval,
  findConstructAgent,
  followConstructAgentEvents,
  listConstructAgentApprovals,
  mintConstructAgentPairingLink,
  openConstructAgentShell,
  parseConstructAgentApprovalId,
  parseConstructAgentEndpoint,
  readConstructAgentUpdates,
  startConstructAgentUpdateEverything,
  type ConstructAgentOptions,
} from "./ConstructAgent.ts";

const TOKEN = "cd".repeat(32);

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly origin: string | undefined;
  readonly features: string | undefined;
  readonly body: string;
}

/** The fake agent's answers; each test sets what it needs. */
const agent = {
  health: { status: "ok", version: "1.4.0", pid: 1, startedAt: "2026-11-14T00:00:00Z" } as Record<string, unknown>,
  update: { version: "1.4.0", channel: "stable", available: null as string | null, state: "idle", error: null, installed: true, checkedAt: null },
  everything: { running: false, parts: [] as Array<Record<string, unknown>> },
  connections: [] as Array<Record<string, unknown>>,
  vmUpdates: new Map<string, { status: number; body: unknown }>(),
  approvals: [] as Array<Record<string, unknown>>,
  entries: [] as Array<Record<string, unknown>>,
  events: "",
  seen: [] as Seen[],
};

let server: NodeHttp.Server;
let port = 0;

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const url = request.url ?? "";
      agent.seen.push({
        method: request.method ?? "",
        url,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        features: request.headers["x-construct-client-features"] as string | undefined,
        body,
      });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (url === "/api/health") return json(200, agent.health);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { title: "no", status: 401, code: "unauthorized" });
      if (url.startsWith("/api/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(agent.events);
        return;
      }
      if (url === "/api/update" || url === "/api/update/check") return json(200, agent.update);
      if (url === "/api/update/everything") {
        if (request.method === "POST") agent.everything = { running: true, parts: [{ part: "device", engine: null, name: "This device", state: "pending" }] };
        return json(request.method === "POST" ? 202 : 200, agent.everything);
      }
      if (url === "/api/connections") return json(200, agent.connections);
      const vm = /^\/api\/engines\/([^/]+)\/api\/v1\/vms\/([^/]+)\/update$/.exec(url);
      if (vm) {
        const answer = agent.vmUpdates.get(`${vm[1]}/${vm[2]}`) ?? { status: 404, body: { code: "not-found" } };
        return json(answer.status, answer.body);
      }
      if (url === "/api/vault/approvals" && request.method === "GET") return json(200, { approvals: agent.approvals, unreachable: [] });
      if (url === "/api/vault/entry-requests" && request.method === "GET") return json(200, { requests: agent.entries, unreachable: [] });
      if (/^\/api\/vault\/(approvals|entry-requests)\//.test(url)) return json(204, undefined);
      if (/^\/api\/connections\/[^/]+\/[^/]+\/t3-pairing$/.test(url)) {
        return json(200, { pairUrl: "https://vm.example:5178/pair#token=one-time", links: [], scopes: "administrative" });
      }
      if (url === "/api/shell/open") return json(204, undefined);
      return json(404, { title: "not found", status: 404, code: "not-found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as NodeNet.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  agent.health = { status: "ok", version: "1.4.0", pid: 1, startedAt: "2026-11-14T00:00:00Z" };
  agent.update = { ...agent.update, available: null };
  agent.everything = { running: false, parts: [] };
  agent.connections = [];
  agent.vmUpdates = new Map();
  agent.approvals = [];
  agent.entries = [];
  agent.events = "";
  agent.seen = [];
});

const endpointFile = () =>
  JSON.stringify({ version: 1, port, token: TOKEN, pid: 1, startedAt: "2026-11-14T00:00:00Z", agentVersion: "1.4.0" });

const options = (text: string | null = endpointFile()): ConstructAgentOptions => ({
  platform: "linux",
  env: {},
  homeDirectory: "/home/user",
  endpointPath: "/fake/endpoint.json",
  readTextFile: () => text,
});

const found = async () => {
  const result = await findConstructAgent(options());
  assert.isNotNull(result);
  return result!;
};

const connection = (vm: string, state = "running") => ({
  engine: "eng1",
  vm,
  alias: vm,
  state,
  address: { host: `${vm}.example`, port: 22, kind: "forwarded" },
  linked: true,
  forwards: [],
  mic: { enabled: false, capturing: false, error: null },
  sshConfig: null,
});

describe("finding the agent", () => {
  it("resolves the token file as the agent writes it", () => {
    assert.equal(
      constructAgentEndpointPath({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, homeDirectory: "C:\\Users\\u" }),
      "C:\\Users\\u\\AppData\\Local\\Construct\\agent\\endpoint.json",
    );
    assert.equal(
      constructAgentEndpointPath({ platform: "linux", env: {}, homeDirectory: "/home/u" }),
      "/home/u/.local/share/construct-agent/endpoint.json",
    );
    assert.equal(
      constructAgentEndpointPath({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, homeDirectory: "/home/u" }),
      "/x/construct-agent/endpoint.json",
    );
    assert.equal(
      constructAgentEndpointPath({ platform: "win32", env: { CONSTRUCT_AGENT_HOME: "D:\\agent" }, homeDirectory: "C:\\Users\\u" }),
      "D:\\agent\\endpoint.json",
    );
    assert.isNull(constructAgentEndpointPath({ platform: "win32", env: {}, homeDirectory: "C:\\Users\\u" }));
  });

  it("accepts only a well-formed token file", () => {
    assert.deepEqual(parseConstructAgentEndpoint(endpointFile()), { port, token: TOKEN });
    assert.isNull(parseConstructAgentEndpoint("{"));
    assert.isNull(parseConstructAgentEndpoint(JSON.stringify({ port: 0, token: TOKEN })));
    assert.isNull(parseConstructAgentEndpoint(JSON.stringify({ port, token: "short" })));
  });

  it("is absent without a token file or without an answer: the old Construct's path stays", async () => {
    assert.isNull(await findConstructAgent(options(null)));
    assert.isNull(await findConstructAgent(options(JSON.stringify({ port: 1, token: TOKEN }))));
    agent.health = { status: "starting" };
    assert.isNull(await findConstructAgent(options()));
  });

  it("checks capabilities both ways", async () => {
    const all = await found();
    assert.isTrue(all.has("update-everything") && all.has("t3-pairing"));
    // Health is asked without the token; every other route with it, and with this build's features.
    const health = agent.seen.find((seen) => seen.url === "/api/health")!;
    assert.isUndefined(health.authorization);
    assert.include(health.features ?? "", "update-everything");
    assert.isUndefined(health.origin);
    agent.health = { ...agent.health, apiFeatures: ["update"] };
    const narrow = await found();
    assert.isFalse(narrow.has("update-everything"));
    const started = await startConstructAgentUpdateEverything(narrow);
    assert.isFalse(started.ok);
    assert.isFalse(agent.seen.some((seen) => seen.url === "/api/update/everything" && seen.method === "POST"));
  });
});

describe("the update control's state", () => {
  it("offers this device's update, a VM's payload and a host release, never a guess", async () => {
    agent.update = { ...agent.update, available: "1.5.0" };
    agent.connections = [connection("dev"), connection("old", "stopped"), connection("broken")];
    agent.vmUpdates.set("eng1/dev", { status: 200, body: { newerPayload: true, availableCommit: "abcdef1234", appliedCommit: "0123456789", hostUpdate: null } });
    agent.vmUpdates.set("eng1/old", { status: 200, body: { newerPayload: false, availableCommit: null, appliedCommit: "0123456789", hostUpdate: { version: "2.0.0", commit: "ff" } } });
    agent.vmUpdates.set("eng1/broken", { status: 502, body: { code: "engine-unreachable" } });
    const read = await readConstructAgentUpdates(await found(), { check: true, withVms: true, previous: null });
    assert.equal(read.view.available, "1.5.0");
    assert.deepEqual(read.view.vms, [
      { name: "dev", version: "abcdef1", host: false },
      { name: "old", version: "2.0.0", host: true },
    ]);
    assert.equal(constructAgentOfferLabel(read.view), "Construct 1.5.0");
    assert.isTrue(agent.seen.some((seen) => seen.url === "/api/update/check" && seen.method === "POST"));
    assert.notInclude(JSON.stringify(read), TOKEN);
  });

  it("keeps the engines' answers on a local read and drops VMs that are gone", async () => {
    agent.connections = [connection("dev")];
    const previous = {
      source: "agent" as const,
      version: "1.4.0",
      available: null,
      vms: [{ name: "dev", version: "abcdef1", host: false }, { name: "gone", version: null, host: false }],
      running: false,
      parts: [],
    };
    const read = await readConstructAgentUpdates(await found(), { check: false, withVms: false, previous });
    assert.deepEqual(read.view.vms, [{ name: "dev", version: "abcdef1", host: false }]);
    assert.isFalse(agent.seen.some((seen) => seen.url.includes("/api/v1/vms/")));
    assert.isFalse(agent.seen.some((seen) => seen.url === "/api/update/check"));
  });

  const fs: ConstructFileSystem = { listDirectories: () => [], fileMtimeMs: () => null, readTextFile: () => null };
  const check = (previous: ConstructUpdateInfo | null, full = true) =>
    checkConstructUpdates({
      appVersion: "0.1.10-nightly.20261113.4656-construct.abcdef12",
      localAppData: undefined,
      fs,
      previous,
      runningAction: previous?.runningAction ?? null,
      now: () => "2026-11-14T00:00:00Z",
      agent: options(),
      ...(full ? { fetchJson: async () => null } : {}),
    });

  it("offers the one Update with an agent: available, running, failed, done", async () => {
    agent.connections = [connection("dev")];
    agent.vmUpdates.set("eng1/dev", { status: 200, body: { newerPayload: true, availableCommit: "abcdef1234", appliedCommit: null, hostUpdate: null } });
    const available = await check(null);
    assert.equal(available.action, "update-everything");
    assert.isNull(available.runningAction);
    assert.isNull(available.scriptsDir);
    assert.equal(available.everything?.source, "agent");
    assert.deepEqual(available.instances.map((instance) => instance.name), ["dev"]);

    assert.isTrue((await startConstructAgentUpdateEverything(await found())).ok);
    const running = await check(available, false);
    assert.equal(running.runningAction, "update-everything");
    // A second start answers the running run; the agent starts nothing twice.
    assert.equal(agent.seen.filter((seen) => seen.url === "/api/update/everything" && seen.method === "POST").length, 1);

    agent.everything = { running: false, parts: [{ part: "vms", engine: "eng1", name: "host-a", state: "failed", detail: "engine refused" }] };
    const failed = await check(running, false);
    assert.isNull(failed.runningAction);
    assert.include(failed.error ?? "", "host-a: engine refused");
    assert.equal(constructAgentRunFailure(failed.everything!), "host-a: engine refused");
    // Right after the run the VMs are asked again.
    assert.isTrue(agent.seen.filter((seen) => seen.url.endsWith("/vms/dev/update")).length >= 2);

    agent.everything = { running: false, parts: [{ part: "vms", engine: "eng1", name: "host-a", state: "done", detail: null }] };
    agent.vmUpdates.set("eng1/dev", { status: 200, body: { newerPayload: false, availableCommit: null, appliedCommit: "abcdef1234", hostUpdate: null } });
    const done = await check(failed);
    assert.isNull(done.action);
    assert.isNull(done.runningAction);
  });

  it("falls back to the scripts when no agent answers", async () => {
    const info = await checkConstructUpdates({
      appVersion: "0.1.10-nightly.20261113.4656-construct.abcdef12",
      localAppData: undefined,
      fs,
      previous: null,
      runningAction: null,
      now: () => "2026-11-14T00:00:00Z",
      agent: options(null),
    });
    assert.isUndefined(info.everything);
    assert.notEqual(info.action, "update-everything");
  });
});

describe("approvals and entry requests", () => {
  const approval = { engine: "eng1", engineName: "Home host", id: "req-7", vm: "dev", op: "request", title: "dev asks for github-token", message: "Reason: release", action: "Approve", names: ["github-token"], reason: "release", source: "agent", createdAt: 1, deadline: 2 };
  const entry = { engine: "eng1", engineName: "Home host", id: "ask-3", vm: "dev", name: "npm-token", description: "npm publish", reason: "release", source: "agent", createdAt: 1, expiresAt: 2 };

  it("lists both, with ids that name the engine and the request", async () => {
    agent.approvals = [approval];
    agent.entries = [entry];
    const items = (await listConstructAgentApprovals(await found()))!;
    assert.deepEqual(items.map((item) => item.id), ["a~eng1~req-7", "e~eng1~ask-3"]);
    assert.isTrue(items[1]!.entry);
    assert.deepEqual(parseConstructAgentApprovalId("e~eng1~ask-3"), { kind: "e", engine: "eng1", id: "ask-3" });
    assert.isNull(parseConstructAgentApprovalId("a~../x~y"));
  });

  it("decides only a request it lists, and the one it was shown for", async () => {
    agent.approvals = [approval];
    agent.entries = [entry];
    const live = await found();
    assert.deepEqual(await decideConstructAgentApproval(live, "a~eng1~other", "approve", undefined), { ok: false, reason: "not-found" });
    assert.isFalse(agent.seen.some((seen) => seen.method === "POST"));
    assert.deepEqual(await decideConstructAgentApproval(live, "a~eng1~req-7", "approve", undefined), { ok: true });
    const allow = agent.seen.find((seen) => seen.method === "POST")!;
    assert.equal(allow.url, "/api/vault/approvals/eng1/req-7");
    assert.deepEqual(JSON.parse(allow.body), { decision: "allow" });
    // An entry request saves a value and declines without one; never an empty value.
    assert.deepEqual(await decideConstructAgentApproval(live, "e~eng1~ask-3", "approve", { value: "" }), { ok: false, reason: "error" });
    assert.deepEqual(await decideConstructAgentApproval(live, "e~eng1~ask-3", "approve", { value: "s3cret" }), { ok: true });
    assert.deepEqual(await decideConstructAgentApproval(live, "e~eng1~ask-3", "deny", undefined), { ok: true });
    const posts = agent.seen.filter((seen) => seen.method === "POST").map((seen) => [seen.url, seen.body]);
    assert.deepEqual(posts.slice(1), [
      ["/api/vault/entry-requests/eng1/ask-3", JSON.stringify({ value: "s3cret" })],
      ["/api/vault/entry-requests/eng1/ask-3/decline", ""],
    ]);
  });
});

describe("pairing link and panel", () => {
  it("mints a link only for one of the user's VMs", async () => {
    agent.connections = [connection("dev")];
    const live = await found();
    const unknown = await mintConstructAgentPairingLink(live, "someone-elses");
    assert.isFalse(unknown.ok);
    assert.isFalse(agent.seen.some((seen) => seen.url.endsWith("/t3-pairing")));
    const link = await mintConstructAgentPairingLink(live, "dev");
    assert.deepEqual(link, { ok: true, pairUrl: "https://vm.example:5178/pair#token=one-time", scopes: "administrative" });
    assert.isTrue(agent.seen.some((seen) => seen.url === "/api/connections/eng1/dev/t3-pairing"));
  });

  it("opens the panel or the VM's page in the agent's window", async () => {
    agent.connections = [connection("dev")];
    const live = await found();
    assert.isTrue(await openConstructAgentShell(live, null));
    assert.isTrue(await openConstructAgentShell(live, "dev"));
    assert.isFalse(await openConstructAgentShell(live, "unknown"));
    const opens = agent.seen.filter((seen) => seen.url === "/api/shell/open").map((seen) => JSON.parse(seen.body));
    assert.deepEqual(opens, [{ surface: "pop" }, { surface: "win", route: "home/dev" }]);
  });
});

describe("events", () => {
  it("parses the agent's stream and resumes from the last id", async () => {
    const seen: Array<[string, number | null]> = [];
    const parse = createConstructAgentEventParser((type, id) => seen.push([type, id]));
    parse(": connected\n\nid: 4\nevent: update\ndata: {}\n\nid: 5\nevent: vault.approval.added\n");
    parse("data: {}\n\n");
    assert.deepEqual(seen, [["update", 4], ["vault.approval.added", 5]]);

    agent.events = "id: 9\nevent: update\ndata: {\"seq\":9}\n\n";
    const types: string[] = [];
    const last = await followConstructAgentEvents(await found(), 8, (type) => types.push(type), new AbortController().signal);
    assert.deepEqual(types, ["update"]);
    assert.equal(last, 9);
    const stream = agent.seen.find((seen) => seen.url.startsWith("/api/events"))!;
    assert.equal(stream.url, "/api/events?since=8");
    assert.equal(stream.authorization, `Bearer ${TOKEN}`);
  });
});
