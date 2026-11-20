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

/** Stop on a settled turn drops the monitors; the plugin's own watcher is not killed. */
export function withoutConstructOpenCodeMonitors(
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<PendingBackgroundTask> {
  return (providerThread.pendingBackgroundTasks ?? []).filter((task) => task.kind !== "monitor");
}

/**
 * Construct: the same watchers under OpenCode 2 (`v2/adapter.ts`), where the plugin's
 * tools report through their metadata. A completed `background` call with
 * `metadata.wait === true` arms `metadata.id` as a monitor of the session that ran it;
 * the plugin's wake (a synthetic message with `metadata.source ===
 * "construct-background"` and `metadata.id`) or a completed `background_kill` call
 * with `metadata.id` ends it. The adapter adds the monitors to the session's roster and
 * counts them as pending background work.
 */
export function makeConstructOpenCode2Monitors() {
  const monitors = new Map<string, ReadonlyArray<PendingBackgroundTask>>();
  const idOf = (metadata: Readonly<Record<string, unknown>> | undefined) => {
    const raw = metadata?.["id"];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const end = (sessionId: string, id: string) => {
    const current = monitors.get(sessionId) ?? [];
    if (id === "" || !current.some((task) => task.taskId === id)) return false;
    const rest = current.filter((task) => task.taskId !== id);
    if (rest.length === 0) monitors.delete(sessionId);
    else monitors.set(sessionId, rest);
    return true;
  };
  return {
    /** A completed tool call; true when it armed or ended a monitor. */
    tool(
      sessionId: string,
      tool: string | undefined,
      metadata: Readonly<Record<string, unknown>> | undefined,
    ): boolean {
      const id = idOf(metadata);
      if (tool === "background_kill") return end(sessionId, id);
      if (tool !== "background" || metadata?.["wait"] !== true || id === "") return false;
      const current = monitors.get(sessionId) ?? [];
      if (current.some((task) => task.taskId === id)) return false;
      const raw = metadata["description"];
      const description = typeof raw === "string" ? raw.trim() : "";
      monitors.set(sessionId, [
        ...current,
        { taskId: id, kind: "monitor", ...(description ? { description } : {}) },
      ]);
      return true;
    },
    /** A synthetic message admitted to the session; true when it was a wake that ended a monitor. */
    wake(sessionId: string, metadata: Readonly<Record<string, unknown>> | undefined): boolean {
      return metadata?.["source"] === "construct-background" && end(sessionId, idOf(metadata));
    },
    has: (sessionId: string) => monitors.has(sessionId),
    tasks: (sessions: ReadonlyArray<{ readonly sessionId: string }>) =>
      sessions.flatMap((session) => monitors.get(session.sessionId) ?? []),
    /** Stop drops the sessions' monitors; the plugin's own watcher is not killed. */
    clear(sessions: ReadonlyArray<{ readonly sessionId: string }>): boolean {
      let changed = false;
      for (const session of sessions) changed = monitors.delete(session.sessionId) || changed;
      return changed;
    },
  };
}
