// @effect-diagnostics nodeBuiltinImport:off globalDate:off - runs the VM's own `construct`
// CLI with a fixed argument list and remembers, in this process, when it started an update.
//
// The new Construct's update for the T3 web UI without the Desktop app (a phone): the VM
// asks its engine through the guest CLI. Nothing from a client reaches the command line:
// both calls are fixed argv, run without a shell, with a deadline and a small output limit.
// A missing command, a non-zero exit or output that is not the expected JSON means "nothing
// to show". The update itself reprovisions this VM, which restarts this server; T3 resumes.
import type { ConstructVmUpdate, ConstructVmUpdateRun } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";

const STATUS_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Status answers are reused for this long: every open client asks. */
const STATUS_CACHE_MS = 60_000;
/** After a started update, the control stays "running" this long unless the VM moved. */
const RUNNING_MS = 30 * 60_000;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export type ConstructCliRunner = (args: ReadonlyArray<string>, timeoutMs: number) => Promise<string | null>;

/** `construct <args>` on PATH; its stdout, or null for a missing command, a failure or a timeout. */
export const runConstructCli: ConstructCliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      NodeChildProcess.execFile(
        "construct",
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false },
        (error, stdout) => resolve(error ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (const line of lines.reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // not this line
    }
  }
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The engine's `GET /vms/{name}/update` answer as the control shows it; null when it is not one. */
export function parseConstructVmUpdateStatus(stdout: string): Omit<ConstructVmUpdate, "running"> | null {
  const value = lastJsonObject(stdout);
  if (value === null || typeof value.newerPayload !== "boolean") return null;
  const host = typeof value.hostUpdate === "object" && value.hostUpdate !== null
    ? (value.hostUpdate as Record<string, unknown>)
    : null;
  const hostVersion = host !== null && typeof host.version === "string" && VERSION.test(host.version)
    ? host.version
    : null;
  const available = typeof value.availableCommit === "string" && COMMIT.test(value.availableCommit)
    ? value.availableCommit.slice(0, 7)
    : null;
  const applied = typeof value.appliedCommit === "string" && COMMIT.test(value.appliedCommit)
    ? value.appliedCommit.slice(0, 7)
    : null;
  return {
    available: value.newerPayload || hostVersion !== null,
    version: hostVersion ?? (value.newerPayload ? available : null),
    host: hostVersion !== null,
    appliedCommit: applied,
  };
}

/** The `POST` answer: started when it names a job. */
export function parseConstructVmUpdateRun(stdout: string): boolean {
  const value = lastJsonObject(stdout);
  if (value === null) return false;
  return [value.jobId, value.hostJobId, value.hostUpdateId].some(
    (id) => typeof id === "string" && id.trim() !== "",
  );
}

export function makeConstructVmUpdate(runner: ConstructCliRunner = runConstructCli, now: () => number = Date.now) {
  let cached: { readonly at: number; readonly value: Omit<ConstructVmUpdate, "running"> | null } | null = null;
  let reading: Promise<Omit<ConstructVmUpdate, "running"> | null> | null = null;
  let startedAt: number | null = null;
  let running: Promise<ConstructVmUpdateRun> | null = null;

  const read = async () => {
    if (cached !== null && now() - cached.at < STATUS_CACHE_MS) return cached.value;
    reading ??= runner(["update", "status", "--json"], STATUS_TIMEOUT_MS)
      .then((stdout) => (stdout === null ? null : parseConstructVmUpdateStatus(stdout)))
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };

  const status = async (): Promise<ConstructVmUpdate> => {
    const value = await read();
    if (value === null || !value.available) {
      // Nothing on offer (any more): a run this server started has done its part.
      if (value !== null) startedAt = null;
      return { available: false, running: false, version: null, host: false, appliedCommit: value?.appliedCommit ?? null };
    }
    const isRunning = startedAt !== null && now() - startedAt < RUNNING_MS;
    return { ...value, running: isRunning };
  };

  const run = async (): Promise<ConstructVmUpdateRun> => {
    // One update at a time: a second click (from this or another client) is answered with
    // the first one's start, never a second run.
    if (startedAt !== null && now() - startedAt < RUNNING_MS) return { started: true, message: null };
    running ??= (async () => {
      const current = await read();
      if (current === null || !current.available) {
        return { started: false, message: "There is no Construct update for this VM." };
      }
      const stdout = await runner(["update", "run", "--json"], RUN_TIMEOUT_MS);
      if (stdout === null || !parseConstructVmUpdateRun(stdout)) {
        return { started: false, message: "The VM could not start its update. Try again later." };
      }
      startedAt = now();
      cached = null;
      return { started: true, message: null };
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return { status, run };
}

const constructVmUpdate = makeConstructVmUpdate();

export const readConstructVmUpdate = (): Effect.Effect<ConstructVmUpdate> =>
  Effect.promise(() => constructVmUpdate.status());

export const runConstructVmUpdate = (): Effect.Effect<ConstructVmUpdateRun> =>
  Effect.promise(() => constructVmUpdate.run());
