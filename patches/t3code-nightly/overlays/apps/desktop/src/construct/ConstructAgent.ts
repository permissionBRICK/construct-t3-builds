// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the agent's token file and its
// loopback HTTP API are plain Node IO with request deadlines; the module stays Effect-free so
// its tests drive it with a fake transport and fake token files.
//
// The Construct device agent on this PC: T3 Desktop's one integration with the new Construct.
//
// The agent (`construct-agent`, which replaces the Companion and the PowerShell client) writes
// its loopback port and a bearer token to `endpoint.json` in its data directory while it runs
// (`%LOCALAPPDATA%\Construct\agent` on Windows, `$XDG_DATA_HOME/construct-agent` or
// `~/.local/share/construct-agent` elsewhere, `CONSTRUCT_AGENT_HOME` overrides both). This
// module finds it, calls the routes of its local API that T3 Desktop uses (a small client
// written by hand against the committed contract `agent/openapi/agent.v1.json`, v1), follows
// its event stream, and turns its answers into the shapes the renderer already knows. The
// token stays in this module: it is never logged, returned, or passed to the renderer.
//
// When no agent answers (a PC still on the old Construct), callers keep today's script path.

import type {
  ConstructEverythingPart,
  ConstructEverythingView,
  ConstructInstanceInfo,
  ConstructPairingLinkResult,
  ConstructVaultApproval,
  ConstructVaultDecideResult,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/** What this T3 Desktop build uses of the agent, sent with every request. */
export const CONSTRUCT_AGENT_CLIENT_FEATURES = [
  "update",
  "update-everything",
  "engine-proxy",
  "events",
  "vault-approvals",
  "vault-entry-requests",
  "connections",
  "t3-pairing",
  "shell-open",
] as const;
export type ConstructAgentFeature = (typeof CONSTRUCT_AGENT_CLIENT_FEATURES)[number];

/** An agent whose health answer names no `apiFeatures` serves the committed v1 contract,
 *  which has every route above. One that names them is taken at its word. */
const CONSTRUCT_AGENT_V1_FEATURES: ReadonlyArray<string> = CONSTRUCT_AGENT_CLIENT_FEATURES;

export const CONSTRUCT_AGENT_CLIENT_HEADER = "X-Construct-Client";
export const CONSTRUCT_AGENT_FEATURES_HEADER = "X-Construct-Client-Features";

const HEALTH_TIMEOUT_MS = 1_500;
const CALL_TIMEOUT_MS = 8_000;
const MAX_ENDPOINT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_EVENT_LINE = 64 * 1024;
const MAX_CONNECTIONS = 32;
const MAX_ITEMS = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// ── Finding the agent ─────────────────────────────────────────────────────────

export interface ConstructAgentLocation {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

/** The token file's path, or null when no data directory resolves. Pure. */
export function constructAgentEndpointPath(location: ConstructAgentLocation): string | null {
  const path = location.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const home = location.env.CONSTRUCT_AGENT_HOME?.trim();
  if (home) return path.isAbsolute(home) ? path.join(home, "endpoint.json") : null;
  if (location.platform === "win32") {
    const base = location.env.LOCALAPPDATA?.trim();
    return base && path.isAbsolute(base)
      ? path.join(base, "Construct", "agent", "endpoint.json")
      : null;
  }
  const xdg = location.env.XDG_DATA_HOME?.trim();
  const root = xdg && path.isAbsolute(xdg) ? xdg : path.join(location.homeDirectory, ".local", "share");
  return path.isAbsolute(root) ? path.join(root, "construct-agent", "endpoint.json") : null;
}

export interface ConstructAgentEndpoint {
  readonly port: number;
  readonly token: string;
}

/** `{version, port, token, pid, startedAt, agentVersion}` (the agent's EndpointFile), or null. */
export function parseConstructAgentEndpoint(text: string): ConstructAgentEndpoint | null {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { port, token } = value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return { port, token };
}

// ── Transport ────────────────────────────────────────────────────────────────

export interface ConstructAgentRequest {
  readonly port: number;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  /** Null for the one route without a token, `GET /api/health`. */
  readonly token: string | null;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

export type ConstructAgentResponse =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "failed" };

export type ConstructAgentTransport = (request: ConstructAgentRequest) => Promise<ConstructAgentResponse>;

function clientHeaders(token: string | null): Record<string, string> {
  return {
    Accept: "application/json",
    [CONSTRUCT_AGENT_CLIENT_HEADER]: "t3-desktop",
    [CONSTRUCT_AGENT_FEATURES_HEADER]: CONSTRUCT_AGENT_CLIENT_FEATURES.join(","),
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  };
}

/** Plain HTTP to 127.0.0.1. Node sends no Origin, which the agent's guard requires. */
export const nodeConstructAgentTransport: ConstructAgentTransport = (request) =>
  new Promise((resolve) => {
    let settled = false;
    const payload = request.body === undefined ? null : JSON.stringify(request.body);
    const finish = (result: ConstructAgentResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outgoing.destroy();
      resolve(result);
    };
    const outgoing = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: request.port,
        method: request.method,
        path: request.path,
        agent: false,
        headers: {
          ...clientHeaders(request.token),
          ...(payload === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) finish({ kind: "failed" });
          else chunks.push(chunk);
        });
        response.on("error", () => finish({ kind: "failed" }));
        response.on("aborted", () => finish({ kind: "failed" }));
        response.on("end", () =>
          finish({ kind: "response", status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    // Errors carry no request data here, and they are never reported anyway.
    outgoing.on("error", () => finish({ kind: "failed" }));
    const deadline = setTimeout(() => finish({ kind: "failed" }), request.timeoutMs);
    outgoing.end(payload ?? undefined);
  });

// ── The client ───────────────────────────────────────────────────────────────

export type ConstructAgentResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code: string | null };

export interface ConstructAgent {
  readonly version: string;
  readonly features: ReadonlySet<string>;
  has(feature: ConstructAgentFeature): boolean;
  /** One call with the token. `path` is built here from fixed text and checked segments. */
  call(method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs?: number): Promise<ConstructAgentResult<unknown>>;
  /** The event stream, see followConstructAgentEvents. */
  readonly port: number;
  readonly tokenForStream: () => string;
}

export interface ConstructAgentOptions extends ConstructAgentLocation {
  readonly readTextFile?: (path: string) => string | null;
  readonly transport?: ConstructAgentTransport;
  /** Tests: the token file to read instead of the one the location resolves. */
  readonly endpointPath?: string;
}

function readSmallFile(path: string): string | null {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile() || stat.size > MAX_ENDPOINT_BYTES) return null;
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The running agent, or null: no token file, a malformed one, or nothing answering its health
 * route with a token that then works. Re-read on every call: the agent writes a new token at
 * every start (its own update restarts it).
 */
export async function findConstructAgent(options: ConstructAgentOptions): Promise<ConstructAgent | null> {
  const path = options.endpointPath ?? constructAgentEndpointPath(options);
  if (path === null) return null;
  const text = (options.readTextFile ?? readSmallFile)(path);
  if (text === null) return null;
  const endpoint = parseConstructAgentEndpoint(text);
  if (endpoint === null) return null;
  const transport = options.transport ?? nodeConstructAgentTransport;
  const health = await transport({
    port: endpoint.port,
    method: "GET",
    path: "/api/health",
    token: null,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  if (health.kind !== "response" || health.status !== 200) return null;
  const body = parseJson(health.body);
  if (!isRecord(body) || body.status !== "ok" || typeof body.version !== "string") return null;
  const named = Array.isArray(body.apiFeatures)
    ? body.apiFeatures.filter((feature): feature is string => typeof feature === "string")
    : null;
  const features = new Set(named ?? CONSTRUCT_AGENT_V1_FEATURES);
  const call: ConstructAgent["call"] = async (method, route, payload, timeoutMs) => {
    const response = await transport({
      port: endpoint.port,
      method,
      path: route,
      token: endpoint.token,
      ...(payload === undefined ? {} : { body: payload }),
      timeoutMs: timeoutMs ?? CALL_TIMEOUT_MS,
    });
    if (response.kind !== "response") return { ok: false, status: 0, code: null };
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, value: response.body === "" ? null : parseJson(response.body) };
    }
    const problem = parseJson(response.body);
    return {
      ok: false,
      status: response.status,
      code: isRecord(problem) && typeof problem.code === "string" ? problem.code.slice(0, 64) : null,
    };
  };
  return {
    version: body.version.slice(0, 64),
    features,
    has: (feature) => features.has(feature),
    call,
    port: endpoint.port,
    tokenForStream: () => endpoint.token,
  };
}

/** A path segment for an engine id, VM name or request id; null when it is not one. */
export function constructAgentSegment(value: unknown): string | null {
  return typeof value === "string" && SEGMENT_PATTERN.test(value) && value !== "." && value !== ".."
    ? value
    : null;
}

// ── Updates ──────────────────────────────────────────────────────────────────

export interface ConstructAgentConnection {
  readonly engine: string;
  readonly vm: string;
  readonly alias: string;
  readonly state: string;
  readonly host: string | null;
  /** `direct` (the VM's own address) or the engine's `forwarded` endpoint. */
  readonly kind: string | null;
}

/** `GET /api/connections`: the user's own primary VMs on every engine. */
export async function listConstructAgentConnections(
  agent: ConstructAgent,
): Promise<ReadonlyArray<ConstructAgentConnection> | null> {
  if (!agent.has("connections")) return [];
  const result = await agent.call("GET", "/api/connections");
  if (!result.ok || !Array.isArray(result.value)) return null;
  const out: ConstructAgentConnection[] = [];
  for (const raw of result.value.slice(0, MAX_CONNECTIONS)) {
    if (!isRecord(raw)) continue;
    const engine = constructAgentSegment(raw.engine);
    const vm = constructAgentSegment(raw.vm);
    const alias = constructAgentSegment(raw.alias);
    if (engine === null || vm === null || alias === null) continue;
    const address = isRecord(raw.address) ? raw.address : null;
    out.push({
      engine,
      vm,
      alias,
      state: typeof raw.state === "string" ? raw.state.slice(0, 32) : "unknown",
      host: address !== null && typeof address.host === "string" ? address.host.slice(0, 253) : null,
      kind: address !== null && typeof address.kind === "string" ? address.kind.slice(0, 32) : null,
    });
  }
  return out;
}

function readPart(raw: unknown): ConstructEverythingPart | null {
  if (!isRecord(raw)) return null;
  const part = raw.part;
  const state = raw.state;
  if (part !== "engine" && part !== "vms" && part !== "device") return null;
  if (
    state !== "pending" &&
    state !== "running" &&
    state !== "done" &&
    state !== "skipped" &&
    state !== "failed"
  ) {
    return null;
  }
  return {
    part,
    name: typeof raw.name === "string" ? raw.name.slice(0, 128) : "",
    state,
    detail: typeof raw.detail === "string" ? raw.detail.slice(0, 300) : null,
  };
}

/** The `GET|POST /api/update/everything` view; null for an answer that is not one. */
export function readConstructAgentEverything(
  value: unknown,
): { readonly running: boolean; readonly parts: ReadonlyArray<ConstructEverythingPart> } | null {
  if (!isRecord(value) || typeof value.running !== "boolean" || !Array.isArray(value.parts)) return null;
  return {
    running: value.running,
    parts: value.parts.slice(0, MAX_ITEMS).flatMap((raw) => {
      const part = readPart(raw);
      return part === null ? [] : [part];
    }),
  };
}

/** A VM's `GET /vms/{name}/update` answer (through the agent's engine proxy). */
interface VmUpdateStatus {
  readonly newerPayload: boolean;
  readonly availableCommit: string | null;
  readonly hostVersion: string | null;
}

export function readConstructVmUpdateStatus(value: unknown): VmUpdateStatus | null {
  if (!isRecord(value) || typeof value.newerPayload !== "boolean") return null;
  const host = isRecord(value.hostUpdate) ? value.hostUpdate : null;
  return {
    newerPayload: value.newerPayload,
    availableCommit: typeof value.availableCommit === "string" ? value.availableCommit.slice(0, 64) : null,
    hostVersion: host !== null && typeof host.version === "string" ? host.version.slice(0, 64) : null,
  };
}

export interface ConstructAgentUpdateRead {
  readonly view: ConstructEverythingView;
  readonly connections: ReadonlyArray<ConstructAgentConnection>;
  readonly error: string | null;
}

/**
 * Everything the update control shows with an agent: this device's own update
 * (`GET /api/update`, or `POST /api/update/check` on a full check), the user's VMs
 * (`GET /api/connections`) and what each one's engine offers (`GET /vms/{vm}/update` through
 * the engine proxy: a newer payload, or a host release it would apply with it), and the
 * "update everything" run. `withVms: false` keeps the engines' last answers (the
 * event-driven refresh).
 */
export async function readConstructAgentUpdates(
  agent: ConstructAgent,
  options: { readonly check: boolean; readonly withVms: boolean; readonly previous: ConstructEverythingView | null },
): Promise<ConstructAgentUpdateRead> {
  const errors: string[] = [];
  const update = await agent.call(options.check ? "POST" : "GET", options.check ? "/api/update/check" : "/api/update");
  let version = options.previous?.version ?? agent.version;
  let available = options.previous?.available ?? null;
  if (update.ok && isRecord(update.value) && typeof update.value.version === "string") {
    version = update.value.version.slice(0, 64);
    available = typeof update.value.available === "string" ? update.value.available.slice(0, 64) : null;
  } else {
    errors.push("The Construct agent could not check for its own update.");
  }
  const everythingAnswer = await agent.call("GET", "/api/update/everything");
  const everything = everythingAnswer.ok ? readConstructAgentEverything(everythingAnswer.value) : null;
  const listed = await listConstructAgentConnections(agent);
  if (listed === null) errors.push("The Construct agent could not list your VMs.");
  const connections = listed ?? [];
  // Kept from the last full read for the VMs still listed; asked again with `withVms`.
  let vms = (options.previous?.vms ?? []).filter((vm) => connections.some((c) => c.alias === vm.name));
  if (options.withVms && listed !== null && agent.has("engine-proxy")) {
    const next: ConstructEverythingView["vms"][number][] = [];
    for (const connection of listed) {
      const answer = await agent.call(
        "GET",
        `/api/engines/${encodeURIComponent(connection.engine)}/api/v1/vms/${encodeURIComponent(connection.vm)}/update`,
      );
      const status = answer.ok ? readConstructVmUpdateStatus(answer.value) : null;
      // An engine that does not answer has nothing to show; never a guessed update.
      if (status === null || (!status.newerPayload && status.hostVersion === null)) continue;
      next.push({
        name: connection.alias,
        version: status.hostVersion ?? (status.availableCommit === null ? null : status.availableCommit.slice(0, 7)),
        host: status.hostVersion !== null,
      });
    }
    vms = next;
  }
  return {
    view: {
      source: "agent",
      version,
      available,
      vms,
      running: everything?.running ?? false,
      parts: everything?.parts ?? [],
    },
    connections,
    error: errors.length > 0 ? errors.join(" ") : null,
  };
}

/**
 * Follows the agent's events for as long as `signal` is not aborted, finding the agent again
 * after it restarts (its own update does that), and calls `onChange` (at most every 250 ms)
 * after an event the update control or the VM list depends on.
 */
export async function watchConstructAgent(
  options: ConstructAgentOptions,
  onChange: () => void,
  signal: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!signal.aborted) onChange();
    }, 250);
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const wait = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(wait);
        resolve();
      }, { once: true });
    });
  let since: number | null = null;
  while (!signal.aborted) {
    const agent = await findConstructAgent(options);
    if (agent === null || !agent.has("events")) {
      since = null;
      await pause(30_000);
      continue;
    }
    since = await followConstructAgentEvents(agent, since, (type) => {
      if (isConstructAgentUpdateEvent(type)) changed();
    }, signal);
    await pause(2_000);
  }
  if (timer !== null) clearTimeout(timer);
}

/** Is there anything for "update everything" to do? */
export function constructAgentHasUpdate(view: ConstructEverythingView, t3UpdateAvailable: boolean): boolean {
  return view.available !== null || view.vms.length > 0 || t3UpdateAvailable;
}

/** The version the control names: this device's offer, else a host release, else a VM payload. */
export function constructAgentOfferLabel(view: ConstructEverythingView): string | null {
  if (view.available !== null) return `Construct ${view.available}`;
  const host = view.vms.find((vm) => vm.host && vm.version !== null);
  if (host !== undefined) return `Construct ${host.version}`;
  const vm = view.vms.find((candidate) => candidate.version !== null);
  return vm === undefined ? null : `Construct ${vm.version}`;
}

/** What a finished run leaves to say: the parts that failed, or null. */
export function constructAgentRunFailure(view: ConstructEverythingView): string | null {
  if (view.running) return null;
  const failed = view.parts.filter((part) => part.state === "failed");
  if (failed.length === 0) return null;
  return failed
    .map((part) => `${part.name}: ${part.detail ?? "the update failed"}`)
    .join(" ");
}

/** `POST /api/update/everything`. The agent starts one run and answers the running one again. */
export async function startConstructAgentUpdateEverything(
  agent: ConstructAgent,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  if (!agent.has("update-everything")) {
    return { ok: false, error: "This Construct agent cannot update everything yet." };
  }
  const result = await agent.call("POST", "/api/update/everything");
  if (result.ok && readConstructAgentEverything(result.value) !== null) return { ok: true };
  return { ok: false, error: "The Construct agent did not start the update." };
}

/** The agent's VMs as the instances the renderer pairs with its remotes. The link marker and
 *  T3 port come from `legacy`, the old Construct's state of the same name, when it has one. */
export function constructAgentInstances(
  connections: ReadonlyArray<ConstructAgentConnection>,
  legacy: (name: string) => Pick<ConstructInstanceInfo, "t3Port" | "t3BaseUrl" | "t3Link" | "channel"> | null,
): ReadonlyArray<ConstructInstanceInfo> {
  return connections.map((connection, index) => {
    const old = legacy(connection.alias);
    return {
      name: connection.alias,
      vmHost: connection.host ?? connection.alias,
      // A forwarded VM's T3 port is the engine's to allocate, as for a host service's VM.
      publicHost: connection.kind === "direct" ? null : connection.host,
      hostAlias: connection.alias,
      isDefault: index === 0,
      provisionedCommit: null,
      channel: old?.channel ?? null,
      t3Port: old?.t3Port ?? null,
      // A running VM of the user's is worth a pairing attempt; the agent says when it has no T3.
      t3Enabled: connection.state === "running",
      t3BaseUrl: old?.t3BaseUrl ?? null,
      t3Link: old?.t3Link ?? null,
    };
  });
}

/** The connection an instance name (its alias) stands for, re-read from the agent. */
async function connectionByName(agent: ConstructAgent, name: string): Promise<ConstructAgentConnection | null> {
  const listed = await listConstructAgentConnections(agent);
  return listed?.find((connection) => connection.alias === name) ?? null;
}

// ── Pairing link, panel, a VM's page ──────────────────────────────────────

/** `POST /api/connections/{engine}/{vm}/t3-pairing`: a one-time link for one of the user's VMs. */
export async function mintConstructAgentPairingLink(
  agent: ConstructAgent,
  name: string,
): Promise<ConstructPairingLinkResult> {
  if (!agent.has("t3-pairing")) return { ok: false, error: "This Construct agent cannot mint T3 pairing links." };
  const connection = await connectionByName(agent, name);
  if (connection === null) return { ok: false, error: `"${name}" is not one of your Construct VMs.` };
  const result = await agent.call(
    "POST",
    `/api/connections/${encodeURIComponent(connection.engine)}/${encodeURIComponent(connection.vm)}/t3-pairing`,
    undefined,
    60_000,
  );
  if (!result.ok || !isRecord(result.value) || typeof result.value.pairUrl !== "string") {
    return {
      ok: false,
      error:
        result.ok || result.code === null
          ? `The Construct agent could not mint a pairing link for ${name}.`
          : `The Construct agent could not mint a pairing link for ${name} (${result.code}).`,
    };
  }
  let url: URL;
  try {
    url = new URL(result.value.pairUrl);
  } catch {
    return { ok: false, error: `The pairing link for ${name} is not a URL.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: `The pairing link for ${name} is not an http(s) link.` };
  }
  return {
    ok: true,
    pairUrl: url.toString(),
    scopes: result.value.scopes === "administrative" ? "administrative" : "standard",
  };
}

/** The panel (`null`) or one VM's page in the agent's window (`POST /api/shell/open`). */
export async function openConstructAgentShell(agent: ConstructAgent, name: string | null): Promise<boolean> {
  if (!agent.has("shell-open")) return false;
  let route: string | null = null;
  if (name !== null) {
    const connection = await connectionByName(agent, name);
    if (connection === null) return false;
    route = `home/${encodeURIComponent(connection.vm)}`;
  }
  const result = await agent.call(
    "POST",
    "/api/shell/open",
    route === null ? { surface: "pop" } : { surface: "win", route },
  );
  return result.ok;
}

// ── Key vault approvals and entry requests ──────────────────────────────────

const ID_SEPARATOR = "~";
const OPS = new Set(["request", "get", "add", "delete", "autoApprove"]);

/** The id the banner uses for an agent item: kind, engine and the engine's id in one. */
export function constructAgentApprovalId(kind: "a" | "e", engine: string, id: string): string {
  return [kind, engine, id].join(ID_SEPARATOR);
}

export function parseConstructAgentApprovalId(
  value: unknown,
): { readonly kind: "a" | "e"; readonly engine: string; readonly id: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(ID_SEPARATOR);
  if (parts.length !== 3 || (parts[0] !== "a" && parts[0] !== "e")) return null;
  const engine = constructAgentSegment(parts[1]);
  const id = constructAgentSegment(parts[2]);
  return engine === null || id === null ? null : { kind: parts[0], engine, id };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sanitizeAgentApproval(raw: unknown): ConstructVaultApproval | null {
  if (!isRecord(raw)) return null;
  const engine = constructAgentSegment(raw.engine);
  const id = constructAgentSegment(raw.id);
  if (engine === null || id === null || typeof raw.createdAt !== "number") return null;
  const names = Array.isArray(raw.names)
    ? raw.names.filter((name): name is string => typeof name === "string" && name !== "").slice(0, 20)
    : [];
  if (names.length === 0) return null;
  const op = typeof raw.op === "string" && OPS.has(raw.op) ? raw.op : "request";
  return {
    id: constructAgentApprovalId("a", engine, id),
    instance: text(raw.vm, 128),
    vm: text(raw.vm, 128),
    kind: "host",
    host: text(raw.engineName, 128) || null,
    requestId: id,
    hostRequestId: id,
    op: op as ConstructVaultApproval["op"],
    title: text(raw.title, 200) || "Key vault request",
    message: text(raw.message, 2_000),
    action: text(raw.action, 32) || "Approve",
    deny: "Deny",
    names: names.map((name) => name.slice(0, 128)),
    createdAt: raw.createdAt,
    deadline: typeof raw.deadline === "number" ? raw.deadline : null,
  };
}

function sanitizeAgentEntryRequest(raw: unknown): ConstructVaultApproval | null {
  if (!isRecord(raw)) return null;
  const engine = constructAgentSegment(raw.engine);
  const id = constructAgentSegment(raw.id);
  const name = text(raw.name, 128);
  if (engine === null || id === null || name === "" || typeof raw.createdAt !== "number") return null;
  const vm = text(raw.vm, 128);
  const reason = text(raw.reason, 500);
  return {
    id: constructAgentApprovalId("e", engine, id),
    instance: vm,
    vm,
    kind: "host",
    host: text(raw.engineName, 128) || null,
    requestId: id,
    hostRequestId: id,
    op: "add",
    title: `Enter the secret ${name}`,
    message: [text(raw.description, 500), reason === "" ? "" : `Reason: ${reason}`, `Asked by ${vm}.`]
      .filter((line) => line !== "")
      .join("\n"),
    action: "Save",
    deny: "Decline",
    names: [name],
    entry: true,
    createdAt: raw.createdAt,
    deadline: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
  };
}

/** The approvals and entry requests the agent's engines wait on, or null when it cannot say. */
export async function listConstructAgentApprovals(
  agent: ConstructAgent,
): Promise<ReadonlyArray<ConstructVaultApproval> | null> {
  if (!agent.has("vault-approvals")) return null;
  const approvals = await agent.call("GET", "/api/vault/approvals", undefined, 4_000);
  if (!approvals.ok || !isRecord(approvals.value) || !Array.isArray(approvals.value.approvals)) return null;
  const items = approvals.value.approvals.flatMap((raw) => {
    const item = sanitizeAgentApproval(raw);
    return item === null ? [] : [item];
  });
  if (agent.has("vault-entry-requests")) {
    const entries = await agent.call("GET", "/api/vault/entry-requests", undefined, 4_000);
    if (entries.ok && isRecord(entries.value) && Array.isArray(entries.value.requests)) {
      for (const raw of entries.value.requests) {
        const item = sanitizeAgentEntryRequest(raw);
        if (item !== null) items.push(item);
      }
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id)).slice(0, MAX_ITEMS);
}

/**
 * The user's decision on ONE item the banner showed. The item is looked up in the agent's
 * current list first, so a decision only ever reaches the request it was shown for; an
 * approval takes approve or deny, an entry request a value (approve) or a decline (deny).
 */
export async function decideConstructAgentApproval(
  agent: ConstructAgent,
  rawId: unknown,
  decision: unknown,
  entry: { readonly value: string; readonly username?: string | undefined } | undefined,
): Promise<ConstructVaultDecideResult> {
  const id = parseConstructAgentApprovalId(rawId);
  if (id === null || (decision !== "approve" && decision !== "deny")) return { ok: false, reason: "error" };
  const listed = await listConstructAgentApprovals(agent);
  if (listed === null) return { ok: false, reason: "unavailable" };
  if (!listed.some((item) => item.id === rawId)) return { ok: false, reason: "not-found" };
  const base =
    id.kind === "a"
      ? `/api/vault/approvals/${encodeURIComponent(id.engine)}/${encodeURIComponent(id.id)}`
      : `/api/vault/entry-requests/${encodeURIComponent(id.engine)}/${encodeURIComponent(id.id)}`;
  let result: ConstructAgentResult<unknown>;
  if (id.kind === "a") {
    result = await agent.call("POST", base, { decision: decision === "approve" ? "allow" : "deny" });
  } else if (decision === "deny") {
    result = await agent.call("POST", `${base}/decline`);
  } else {
    if (entry === undefined || typeof entry.value !== "string" || entry.value === "" || entry.value.length > 16_384) {
      return { ok: false, reason: "error" };
    }
    result = await agent.call("POST", base, {
      value: entry.value,
      ...(typeof entry.username === "string" && entry.username !== "" ? { username: entry.username.slice(0, 256) } : {}),
    });
  }
  if (result.ok) return { ok: true };
  if (result.status === 0) return { ok: false, reason: "unavailable" };
  if (result.status === 404) return { ok: false, reason: "not-found" };
  if (result.status === 409) return { ok: false, reason: "already-decided" };
  if (result.status === 403 || result.status === 502) return { ok: false, reason: "host-failed" };
  return { ok: false, reason: "error" };
}

// ── Events ───────────────────────────────────────────────────────────────────

/** The event types after which the update control or the instances are re-read. */
const UPDATE_EVENTS = new Set([
  "update",
  "update.offered",
  "update.finished",
  "connections",
  "agent",
  "engine.reset",
  "reset",
  "job.ended",
]);

export function isConstructAgentUpdateEvent(type: string): boolean {
  return UPDATE_EVENTS.has(type);
}

/** Splits an SSE stream into events; keeps the last `id`. Pure apart from its own buffer. */
export function createConstructAgentEventParser(onEvent: (type: string, id: number | null) => void) {
  let buffer = "";
  let type = "message";
  let id: number | null = null;
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (type !== "message" || id !== null) onEvent(type, id);
        type = "message";
      } else if (line.startsWith("event:")) {
        type = line.slice(6).trim().slice(0, 64);
      } else if (line.startsWith("id:")) {
        const value = Number(line.slice(3).trim());
        if (Number.isSafeInteger(value)) id = value;
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_EVENT_LINE) buffer = "";
  };
}

/**
 * Follows `GET /api/events` until `signal` aborts, calling `onEvent` with each event type; on a
 * drop it resumes from the last id (the agent answers `reset` when that is gone). Resolves when
 * the stream ends; the caller decides whether to follow again.
 */
export function followConstructAgentEvents(
  agent: Pick<ConstructAgent, "port" | "tokenForStream">,
  since: number | null,
  onEvent: (type: string, id: number | null) => void,
  signal: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    let last = since;
    const parse = createConstructAgentEventParser((type, id) => {
      if (id !== null) last = id;
      onEvent(type, id);
    });
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: agent.port,
        method: "GET",
        path: since === null ? "/api/events" : `/api/events?since=${since}`,
        agent: false,
        headers: { ...clientHeaders(agent.tokenForStream()), Accept: "text/event-stream" },
        signal,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(last);
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => parse(chunk));
        response.on("end", () => resolve(last));
        response.on("error", () => resolve(last));
        response.on("aborted", () => resolve(last));
      },
    );
    request.on("error", () => resolve(last));
    request.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
