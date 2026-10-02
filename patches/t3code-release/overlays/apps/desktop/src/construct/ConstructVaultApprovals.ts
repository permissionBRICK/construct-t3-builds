// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the Companion's endpoint
// file and its loopback HTTP API are plain Node IO with a request deadline; the module
// stays Effect-free so its tests drive it with a fake server and fake endpoint files.
//
// Key vault approvals through the Construct Companion on this PC.
//
// The Companion (Windows tray app) writes `%LOCALAPPDATA%\The-Construct\companion\
// endpoint.json` with its loopback port and a bearer token (the contract of
// extension/src/companion.js `parseEndpoint`). The Desktop main process lists the
// approvals the Companion waits on and forwards the user's decision; the token stays in
// this module: it is never logged, returned or passed to the renderer.

import type {
  ConstructVaultApproval,
  ConstructVaultApprovalsResult,
  ConstructVaultDecideResult,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const COMPANION_IPC_API_VERSION = 1;
/** The Companion answers from memory: a slow answer means it is hung, not busy. */
export const COMPANION_LIST_TIMEOUT_MS = 2_000;
/** A host approval is forwarded to the host service before the Companion answers. */
export const COMPANION_DECIDE_TIMEOUT_MS = 8_000;
const MAX_ENDPOINT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_APPROVALS = 50;
const MAX_NAMES = 20;
const MAX_ID = 128;
const MAX_LABEL = 128;
const MAX_NAME = 128;
const MAX_TITLE = 200;
const MAX_MESSAGE = 2_000;
const MAX_BUTTON = 32;

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const KINDS = new Set(["local", "host"]);
const OPS = new Set(["request", "get", "add", "delete"]);

export interface CompanionEndpoint {
  readonly port: number;
  readonly pid: number;
  readonly token: string;
}

export interface ConstructVaultCompanionOptions {
  readonly platform: string;
  readonly localAppData: string | undefined;
  readonly temp: string | undefined;
  /** Tests: the endpoint file to read instead of the one under %LOCALAPPDATA%. */
  readonly endpointPath?: string;
  /** Tests: whether the Companion process recorded in the endpoint file still runs. */
  readonly pidAlive?: (pid: number) => boolean;
  readonly listTimeoutMs?: number;
  readonly decideTimeoutMs?: number;
}

/** `<LOCALAPPDATA or TEMP>\The-Construct\companion\endpoint.json`, Windows only. */
export function companionEndpointPath(
  platform: string,
  localAppData: string | undefined,
  temp: string | undefined,
): string | null {
  if (platform !== "win32") return null;
  const base = localAppData || temp;
  if (!base || !NodePath.win32.isAbsolute(base)) return null;
  return NodePath.win32.join(base, "The-Construct", "companion", "endpoint.json");
}

/** The same rules as the Companion client's `parseEndpoint`; null for anything else. */
export function parseCompanionEndpoint(text: string): CompanionEndpoint | null {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (
    e.v !== 1 ||
    e.ipcApiVersion !== COMPANION_IPC_API_VERSION ||
    typeof e.port !== "number" ||
    !Number.isInteger(e.port) ||
    e.port < 1 ||
    e.port > 65_535 ||
    typeof e.pid !== "number" ||
    !Number.isSafeInteger(e.pid) ||
    e.pid <= 0 ||
    typeof e.token !== "string" ||
    !TOKEN_PATTERN.test(e.token) ||
    typeof e.version !== "string" ||
    e.version === "" ||
    typeof e.startedAt !== "string" ||
    !Number.isFinite(Date.parse(e.startedAt))
  ) {
    return null;
  }
  return { port: e.port, pid: e.pid, token: e.token };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** The running Companion's endpoint, or null: not Windows, no file, malformed, dead pid. */
export function readCompanionEndpoint(
  options: ConstructVaultCompanionOptions,
): CompanionEndpoint | null {
  const path =
    options.endpointPath ??
    companionEndpointPath(options.platform, options.localAppData, options.temp);
  if (options.platform !== "win32" || path === null) return null;
  let text: string;
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile() || stat.size > MAX_ENDPOINT_BYTES) return null;
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const endpoint = parseCompanionEndpoint(text);
  if (endpoint === null) return null;
  return (options.pidAlive ?? isProcessAlive)(endpoint.pid) ? endpoint : null;
}

type CompanionResponse =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  /** No connection: nothing listens on the port. */
  | { readonly kind: "unreachable" }
  /** Connected, but no complete answer in time (or an oversized one). */
  | { readonly kind: "failed" };

function companionRequest(
  endpoint: CompanionEndpoint,
  method: "GET" | "POST",
  route: string,
  body: unknown,
  timeoutMs: number,
): Promise<CompanionResponse> {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const payload = body === undefined ? null : JSON.stringify(body);
    const finish = (result: CompanionResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(result);
    };
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        method,
        path: route,
        agent: false,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          Accept: "application/json",
          ...(payload === null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
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
          finish({
            kind: "response",
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
      });
    });
    // Errors carry no request data here, and they are never reported anyway.
    request.on("error", () => finish({ kind: connected ? "failed" : "unreachable" }));
    const deadline = setTimeout(() => finish({ kind: "failed" }), timeoutMs);
    request.end(payload ?? undefined);
  });
}

/** Cut to `max` characters without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 2);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? clip(value, max) : undefined;
}

function optionalTime(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One validated approval, or null for an item that does not match the contract. */
export function sanitizeCompanionApproval(value: unknown): ConstructVaultApproval | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !APPROVAL_ID_PATTERN.test(item.id)) return null;
  if (typeof item.kind !== "string" || !KINDS.has(item.kind)) return null;
  if (typeof item.op !== "string" || !OPS.has(item.op)) return null;
  for (const key of ["instance", "vm", "title", "message", "action", "deny"] as const) {
    if (typeof item[key] !== "string") return null;
  }
  if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) return null;
  if (!Array.isArray(item.names) || item.names.length === 0) return null;
  if (!item.names.every((name): name is string => typeof name === "string" && name !== "")) {
    return null;
  }
  const host = optionalText(item.host, MAX_LABEL);
  const requestId = optionalText(item.requestId, MAX_ID);
  const hostRequestId = optionalText(item.hostRequestId, MAX_ID);
  const deadline = optionalTime(item.deadline);
  if (
    host === undefined ||
    requestId === undefined ||
    hostRequestId === undefined ||
    deadline === undefined
  ) {
    return null;
  }
  return {
    id: item.id,
    instance: clip(item.instance as string, MAX_LABEL),
    vm: clip(item.vm as string, MAX_LABEL),
    kind: item.kind as ConstructVaultApproval["kind"],
    host,
    requestId,
    hostRequestId,
    op: item.op as ConstructVaultApproval["op"],
    title: clip(item.title as string, MAX_TITLE),
    message: clip(item.message as string, MAX_MESSAGE),
    action: clip(item.action as string, MAX_BUTTON),
    deny: clip(item.deny as string, MAX_BUTTON),
    names: item.names.slice(0, MAX_NAMES).map((name) => clip(name, MAX_NAME)),
    createdAt: item.createdAt,
    deadline,
  };
}

/** The approvals of a `GET /v1/vault/approvals` answer, or null for a malformed answer. */
export function parseCompanionApprovals(
  body: string,
): ReadonlyArray<ConstructVaultApproval> | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const approvals = (value as { approvals?: unknown }).approvals;
  if (!Array.isArray(approvals)) return null;
  const seen = new Set<string>();
  const valid: ConstructVaultApproval[] = [];
  for (const raw of approvals) {
    const approval = sanitizeCompanionApproval(raw);
    if (approval === null || seen.has(approval.id)) continue;
    seen.add(approval.id);
    valid.push(approval);
    if (valid.length === MAX_APPROVALS) break;
  }
  return valid;
}

/** The approvals the Companion waits on, or `available: false` when it cannot be asked. */
export async function listConstructVaultApprovals(
  options: ConstructVaultCompanionOptions,
): Promise<ConstructVaultApprovalsResult> {
  const endpoint = readCompanionEndpoint(options);
  if (endpoint === null) return { available: false };
  const response = await companionRequest(
    endpoint,
    "GET",
    "/v1/vault/approvals",
    undefined,
    options.listTimeoutMs ?? COMPANION_LIST_TIMEOUT_MS,
  );
  // 401 (a stale token), 404 (a Companion without the route) and failures alike.
  if (response.kind !== "response" || response.status !== 200) return { available: false };
  const approvals = parseCompanionApprovals(response.body);
  return approvals === null ? { available: false } : { available: true, approvals };
}

export function isConstructVaultApprovalId(id: unknown): id is string {
  return typeof id === "string" && APPROVAL_ID_PATTERN.test(id);
}

/** Forward the user's decision on one Companion approval. */
export async function decideConstructVaultApproval(
  id: unknown,
  decision: unknown,
  options: ConstructVaultCompanionOptions,
): Promise<ConstructVaultDecideResult> {
  if (!isConstructVaultApprovalId(id) || (decision !== "approve" && decision !== "deny")) {
    return { ok: false, reason: "error" };
  }
  const endpoint = readCompanionEndpoint(options);
  if (endpoint === null) return { ok: false, reason: "unavailable" };
  const response = await companionRequest(
    endpoint,
    "POST",
    `/v1/vault/approvals/${encodeURIComponent(id)}`,
    { decision },
    options.decideTimeoutMs ?? COMPANION_DECIDE_TIMEOUT_MS,
  );
  if (response.kind === "unreachable") return { ok: false, reason: "unavailable" };
  if (response.kind === "failed") return { ok: false, reason: "error" };
  if (response.status >= 200 && response.status < 300) return { ok: true };
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status === 409) return { ok: false, reason: "already-decided" };
  return { ok: false, reason: "error" };
}
