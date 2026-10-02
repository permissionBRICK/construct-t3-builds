// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a fake Companion on a
// loopback port (with delayed answers) and fake endpoint files in a temporary directory.
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  companionEndpointPath,
  type ConstructVaultCompanionOptions,
  decideConstructVaultApproval,
  listConstructVaultApprovals,
  parseCompanionApprovals,
  parseCompanionEndpoint,
  readCompanionEndpoint,
  sanitizeCompanionApproval,
} from "./ConstructVaultApprovals.ts";

const TOKEN = "ab".repeat(32);
const PID = 4242;

const approval = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "appr-1",
  instance: "agent-vm",
  vm: "agent-vm",
  kind: "local",
  host: null,
  requestId: "req-1",
  hostRequestId: null,
  op: "request",
  title: "Key vault request from agent-vm",
  message: "The agent asks for github-token.\nReason: publish the release",
  action: "Approve",
  deny: "Deny",
  names: ["github-token"],
  createdAt: 1_800_000_000_000,
  deadline: 1_800_000_300_000,
  ...over,
});

const endpointJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    ipcApiVersion: 1,
    port: 1,
    pid: PID,
    token: TOKEN,
    version: "1.2.3",
    startedAt: "2026-10-02T08:00:00.000Z",
    ...over,
  });

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A fake Companion: answers with whatever the test put into `reply`. */
let reply: (seen: Seen) => { status: number; body?: string; delayMs?: number } = () => ({
  status: 200,
  body: JSON.stringify({ approvals: [] }),
});
const requests: Seen[] = [];
let server: NodeHttp.Server;
let port = 0;
let dir = "";

beforeAll(async () => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-construct-vault-"));
  server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      };
      requests.push(seen);
      // A wrong token is always refused, whatever the test wants to answer.
      const answer =
        seen.authorization === `Bearer ${TOKEN}` ? reply(seen) : { status: 401, body: "" };
      setTimeout(() => {
        response.writeHead(answer.status, { "Content-Type": "application/json" });
        response.end(answer.body ?? "");
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as NodeNet.AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

let fileCount = 0;
function options(
  text: string | null,
  over: Partial<ConstructVaultCompanionOptions> = {},
): ConstructVaultCompanionOptions {
  const endpointPath = NodePath.join(dir, `endpoint-${++fileCount}.json`);
  if (text !== null) NodeFS.writeFileSync(endpointPath, text);
  return {
    platform: "win32",
    localAppData: "C:\\Users\\user\\AppData\\Local",
    temp: undefined,
    endpointPath,
    pidAlive: (pid) => pid === PID,
    ...over,
  };
}
const live = (over: Record<string, unknown> = {}) => endpointJson({ port, ...over });

describe("companionEndpointPath", () => {
  it("lives under LOCALAPPDATA (or TEMP) on Windows only", () => {
    assert.equal(
      companionEndpointPath("win32", "C:\\Users\\user\\AppData\\Local", "C:\\Temp"),
      "C:\\Users\\user\\AppData\\Local\\The-Construct\\companion\\endpoint.json",
    );
    assert.equal(
      companionEndpointPath("win32", undefined, "C:\\Temp"),
      "C:\\Temp\\The-Construct\\companion\\endpoint.json",
    );
    assert.isNull(companionEndpointPath("win32", "relative\\dir", undefined));
    assert.isNull(companionEndpointPath("win32", undefined, undefined));
    assert.isNull(companionEndpointPath("linux", "/home/user", "/tmp"));
    assert.isNull(companionEndpointPath("darwin", "/Users/user", "/tmp"));
  });
});

describe("parseCompanionEndpoint", () => {
  it("accepts the Companion's endpoint file, with or without a BOM", () => {
    assert.deepEqual(parseCompanionEndpoint(endpointJson({ port: 4100 })), {
      port: 4100,
      pid: PID,
      token: TOKEN,
    });
    assert.deepEqual(parseCompanionEndpoint(`\uFEFF${endpointJson({ port: 4100 })}`)?.port, 4100);
  });

  it("rejects anything outside the contract", () => {
    for (const over of [
      { v: 2 },
      { ipcApiVersion: 2 },
      { port: 0 },
      { port: 65_536 },
      { port: 80.5 },
      { port: "4100" },
      { pid: 0 },
      { pid: -1 },
      { pid: 1.5 },
      { token: "ab".repeat(31) },
      { token: `${"ab".repeat(31)}zz` },
      { version: "" },
      { version: 1 },
      { startedAt: "not a date" },
    ]) {
      assert.isNull(parseCompanionEndpoint(endpointJson(over)), JSON.stringify(over));
    }
    assert.isNull(parseCompanionEndpoint("not json"));
    assert.isNull(parseCompanionEndpoint("[]"));
    assert.isNull(parseCompanionEndpoint("null"));
  });
});

describe("readCompanionEndpoint", () => {
  it("needs a readable file and a running Companion process", () => {
    assert.deepEqual(readCompanionEndpoint(options(live()))?.port, port);
    assert.isNull(readCompanionEndpoint(options(null)), "no file");
    assert.isNull(readCompanionEndpoint(options("{")), "malformed");
    assert.isNull(readCompanionEndpoint(options(live({ pid: 999 }))), "dead pid");
    assert.isNull(readCompanionEndpoint(options(live(), { platform: "linux" })), "not Windows");
    assert.isNull(readCompanionEndpoint(options(`${live()}${" ".repeat(20_000)}`)), "oversized");
  });
});

describe("sanitizeCompanionApproval", () => {
  it("keeps a valid approval and treats missing nullable fields as null", () => {
    assert.deepEqual(sanitizeCompanionApproval(approval()), approval());
    const { host: _host, requestId: _requestId, deadline: _deadline, ...bare } = approval();
    const sanitized = sanitizeCompanionApproval(bare);
    assert.isNull(sanitized?.host);
    assert.isNull(sanitized?.requestId);
    assert.isNull(sanitized?.deadline);
  });

  it("drops items that break the contract", () => {
    for (const over of [
      { id: "" },
      { id: "has space" },
      { id: "a/b" },
      { id: "x".repeat(129) },
      { kind: "remote" },
      { op: "export" },
      { title: 1 },
      { message: null },
      { action: undefined },
      { vm: [] },
      { names: [] },
      { names: "github-token" },
      { names: ["ok", 1] },
      { names: [""] },
      { createdAt: "now" },
      { createdAt: Number.NaN },
      { deadline: "soon" },
      { host: 7 },
      { requestId: {} },
      { hostRequestId: true },
    ]) {
      assert.isNull(sanitizeCompanionApproval(approval(over)), JSON.stringify(over));
    }
    assert.isNull(sanitizeCompanionApproval(null));
    assert.isNull(sanitizeCompanionApproval([approval()]));
  });

  it("clips long texts and long name lists", () => {
    const sanitized = sanitizeCompanionApproval(
      approval({
        title: "t".repeat(500),
        message: "m".repeat(5_000),
        action: "a".repeat(100),
        names: Array.from({ length: 30 }, (_, index) => `name-${index}`),
      }),
    );
    assert.equal(sanitized?.title.length, 200);
    assert.isTrue(sanitized?.title.endsWith("…"));
    assert.equal(sanitized?.message.length, 2_000);
    assert.equal(sanitized?.action.length, 32);
    assert.equal(sanitized?.names.length, 20);
    // A surrogate pair at the cut is dropped whole, never split.
    const emoji = sanitizeCompanionApproval(approval({ title: `${"t".repeat(198)}😀😀` }));
    assert.equal(emoji?.title, `${"t".repeat(198)}…`);
  });
});

describe("parseCompanionApprovals", () => {
  it("keeps the valid items and drops the rest", () => {
    const parsed = parseCompanionApprovals(
      JSON.stringify({
        approvals: [approval(), approval({ id: "bad id" }), approval(), approval({ id: "appr-2" })],
      }),
    );
    assert.deepEqual(
      parsed?.map((item) => item.id),
      ["appr-1", "appr-2"],
    );
    assert.isNull(parseCompanionApprovals("{}"));
    assert.isNull(parseCompanionApprovals('{"approvals":{}}'));
    assert.isNull(parseCompanionApprovals("[]"));
    assert.isNull(parseCompanionApprovals("nope"));
  });
});

describe("listConstructVaultApprovals", () => {
  it("lists the Companion's approvals with the bearer token", async () => {
    reply = () => ({
      status: 200,
      body: JSON.stringify({ approvals: [approval(), { id: "broken" }] }),
    });
    requests.length = 0;
    const result = await listConstructVaultApprovals(options(live()));
    assert.deepEqual<unknown>(result, { available: true, approvals: [approval()] });
    assert.deepEqual(
      requests.map((seen) => [seen.method, seen.url, seen.authorization]),
      [["GET", "/v1/vault/approvals", `Bearer ${TOKEN}`]],
    );
    // The token never travels back to the caller.
    assert.notInclude(JSON.stringify(result), TOKEN);
  });

  it("is unavailable without a usable endpoint, without the route, or on failure", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ approvals: [] }) });
    requests.length = 0;
    assert.deepEqual(await listConstructVaultApprovals(options(null)), { available: false });
    assert.deepEqual(await listConstructVaultApprovals(options("garbage")), { available: false });
    assert.deepEqual(await listConstructVaultApprovals(options(live({ pid: 7 }))), {
      available: false,
    });
    assert.deepEqual(await listConstructVaultApprovals(options(live(), { platform: "darwin" })), {
      available: false,
    });
    assert.equal(requests.length, 0, "nothing is asked without a running Companion");

    // A wrong token: the fake Companion answers 401.
    assert.deepEqual(await listConstructVaultApprovals(options(live({ token: "cd".repeat(32) }))), {
      available: false,
    });
    reply = () => ({ status: 404, body: '{"code":"not-found"}' });
    assert.deepEqual(await listConstructVaultApprovals(options(live())), { available: false });
    reply = () => ({ status: 200, body: "<html>" });
    assert.deepEqual(await listConstructVaultApprovals(options(live())), { available: false });
    reply = () => ({ status: 200, body: JSON.stringify({ approvals: [] }), delayMs: 500 });
    assert.deepEqual(await listConstructVaultApprovals(options(live(), { listTimeoutMs: 50 })), {
      available: false,
    });
  });

  it("is unavailable when nothing listens on the port", async () => {
    const closedPort = await unusedPort();
    assert.deepEqual(await listConstructVaultApprovals(options(live({ port: closedPort }))), {
      available: false,
    });
  });
});

async function unusedPort(): Promise<number> {
  const closed = NodeHttp.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as NodeNet.AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  return closedPort;
}

describe("decideConstructVaultApproval", () => {
  it("posts the decision for the approval", async () => {
    reply = () => ({ status: 204 });
    requests.length = 0;
    assert.deepEqual(await decideConstructVaultApproval("appr-1", "approve", options(live())), {
      ok: true,
    });
    assert.deepEqual(await decideConstructVaultApproval("a.b~c_d-1", "deny", options(live())), {
      ok: true,
    });
    assert.deepEqual(
      requests.map((seen) => [seen.method, seen.url, seen.authorization, JSON.parse(seen.body)]),
      [
        ["POST", "/v1/vault/approvals/appr-1", `Bearer ${TOKEN}`, { decision: "approve" }],
        ["POST", "/v1/vault/approvals/a.b~c_d-1", `Bearer ${TOKEN}`, { decision: "deny" }],
      ],
    );
  });

  it("maps 404 and 409, and refuses invalid arguments without asking", async () => {
    reply = () => ({ status: 404, body: '{"code":"not-found"}' });
    assert.deepEqual(await decideConstructVaultApproval("appr-1", "approve", options(live())), {
      ok: false,
      reason: "not-found",
    });
    reply = () => ({ status: 409, body: '{"code":"already-decided"}' });
    assert.deepEqual(await decideConstructVaultApproval("appr-1", "deny", options(live())), {
      ok: false,
      reason: "already-decided",
    });
    reply = () => ({ status: 400, body: "" });
    assert.deepEqual(await decideConstructVaultApproval("appr-1", "deny", options(live())), {
      ok: false,
      reason: "error",
    });

    reply = () => ({ status: 204 });
    requests.length = 0;
    for (const [id, decision] of [
      ["appr-1", "maybe"],
      ["appr-1", "APPROVE"],
      ["../health", "approve"],
      ["a b", "approve"],
      ["", "approve"],
      ["x".repeat(129), "approve"],
      [42, "approve"],
    ] as const) {
      assert.deepEqual(
        await decideConstructVaultApproval(id, decision, options(live())),
        { ok: false, reason: "error" },
        `${String(id)} ${decision}`,
      );
    }
    assert.equal(requests.length, 0);
  });

  it("is unavailable without a Companion, and an error with a wrong token or a hang", async () => {
    reply = () => ({ status: 204 });
    assert.deepEqual(await decideConstructVaultApproval("appr-1", "approve", options(null)), {
      ok: false,
      reason: "unavailable",
    });
    assert.deepEqual(
      await decideConstructVaultApproval("appr-1", "approve", options(live({ pid: 1 }))),
      { ok: false, reason: "unavailable" },
    );
    assert.deepEqual(
      await decideConstructVaultApproval(
        "appr-1",
        "approve",
        options(live({ port: await unusedPort() })),
      ),
      { ok: false, reason: "unavailable" },
    );
    assert.deepEqual(
      await decideConstructVaultApproval(
        "appr-1",
        "approve",
        options(live({ token: "cd".repeat(32) })),
      ),
      { ok: false, reason: "error" },
    );
    reply = () => ({ status: 204, delayMs: 500 });
    assert.deepEqual(
      await decideConstructVaultApproval(
        "appr-1",
        "approve",
        options(live(), { decideTimeoutMs: 50 }),
      ),
      { ok: false, reason: "error" },
    );
  });
});
