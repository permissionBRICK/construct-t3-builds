import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Part as OpenCodePart } from "@opencode-ai/sdk/v2";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

/**
 * Construct: the OpenCode background plugin signals its watchers through
 * ordinary parts. A completed `background` tool with `metadata.wait === true`
 * arms `metadata.id`; a user text starting `<background-task id="..."
 * status="...">` or a completed `background_kill` tool ends that id. An armed
 * watcher is a pending `monitor` of the root provider thread, which T3 shows
 * as "Waiting on monitor" and which keeps the session from idling out.
 */
type PendingBackgroundTask = NonNullable<
  OrchestrationV2ProviderThread["pendingBackgroundTasks"]
>[number];

const WAKE = /^<background-task id="([^"]+)" status="[^"]+">/;

/** The roster after `part`, or null when the part changes nothing. */
export function constructOpenCodeMonitorRoster(
  current: ReadonlyArray<PendingBackgroundTask>,
  part: OpenCodePart,
  userText: boolean,
): ReadonlyArray<PendingBackgroundTask> | null {
  let ended: string | undefined;
  if (part.type === "tool" && part.state.status === "completed") {
    const raw = part.state.metadata?.["id"];
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id === "") return null;
    if (part.tool === "background" && part.state.metadata["wait"] === true) {
      if (current.some((task) => task.taskId === id)) return null;
      const description = part.state.title.trim();
      return [...current, { taskId: id, kind: "monitor", ...(description ? { description } : {}) }];
    }
    if (part.tool === "background_kill") ended = id;
  } else if (part.type === "text" && userText) {
    ended = WAKE.exec(part.text)?.[1];
  }
  if (ended === undefined || !current.some((task) => task.taskId === ended)) return null;
  return current.filter((task) => task.taskId !== ended);
}

export function hasConstructOpenCodeMonitor(
  providerThread: OrchestrationV2ProviderThread | undefined,
): boolean {
  return (providerThread?.pendingBackgroundTasks ?? []).some((task) => task.kind === "monitor");
}

/** Stop on a settled turn drops the monitors; markConstructOpenCodeStop disarms the plugin's watchers. */
export function withoutConstructOpenCodeMonitors(
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<PendingBackgroundTask> {
  return (providerThread.pendingBackgroundTasks ?? []).filter((task) => task.kind !== "monitor");
}

/**
 * Construct: Stop also disarms the background plugin's watchers. The plugin reads this
 * marker (`<XDG_STATE_HOME or ~/.local/state>/opencode/background/<sessionID>/stopped`,
 * epoch milliseconds of the last Stop) and never wakes a session for a `wait: true`
 * task started before it. A Stop of a running turn aborts the session, which the
 * plugin sees by itself; a Stop of a settled turn reaches OpenCode only through this.
 */
export function markConstructOpenCodeStop(
  sessionId: string,
  at: number = Date.now(),
  stateHome: string = process.env.XDG_STATE_HOME || NodePath.join(NodeOS.homedir(), ".local", "state"),
): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
  try {
    const dir = NodePath.join(stateHome, "opencode", "background", sessionId);
    NodeFS.mkdirSync(dir, { recursive: true });
    const file = NodePath.join(dir, "stopped");
    const part = `${file}.${process.pid}.part`;
    NodeFS.writeFileSync(part, String(at));
    NodeFS.renameSync(part, file);
    return true;
  } catch {
    return false;
  }
}
