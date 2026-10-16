import type { ConstructOmniloopWorkflow, OrchestrationV2TurnItem } from "@t3tools/contracts";

const WORKFLOW_ID = /\bwf_[A-Za-z0-9_-]{6,}\b/g;
const LIVE_STATUSES: ReadonlySet<ConstructOmniloopWorkflow["status"]> = new Set([
  "pending",
  "running",
  "paused",
]);

type ToolTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

/** An MCP tool call that went to the omniloop server (`mcp__omniloop__submit`, `omniloop.submit`). */
export function isOmniloopToolItem(item: OrchestrationV2TurnItem): item is ToolTurnItem {
  if (item.type !== "dynamic_tool") return false;
  return [item.toolName, item.title].some(
    (name) => typeof name === "string" && /omniloop/i.test(name),
  );
}

/**
 * Workflow ids a thread has touched, oldest first. Omniloop's `submit` result
 * carries the new id and `status`/`await`/`inspect` calls name it in their
 * arguments, so scanning the tool input and output text finds every workflow
 * the agent dealt with without knowing each tool's shape.
 */
export function extractOmniloopWorkflowIds(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isOmniloopToolItem(item)) continue;
    const text = JSON.stringify([item.input ?? null, item.output ?? null]);
    for (const match of text.matchAll(WORKFLOW_ID)) ids.add(match[0]);
  }
  return [...ids];
}

export function isLiveOmniloopWorkflow(workflow: ConstructOmniloopWorkflow): boolean {
  return LIVE_STATUSES.has(workflow.status);
}

export interface OmniloopWorkflowNotice {
  readonly title: string;
  readonly workflowId: string;
}

/** The composer banner for a thread's workflows, or null while none is live. */
export function describeOmniloopWorkflows(
  workflows: ReadonlyArray<ConstructOmniloopWorkflow>,
): OmniloopWorkflowNotice | null {
  const live = workflows.filter(isLiveOmniloopWorkflow);
  if (live.length === 0) return null;
  const newest = live[live.length - 1]!;
  if (live.length === 1) {
    const verb =
      newest.status === "paused" ? "paused" : newest.status === "pending" ? "queued" : "running";
    return { title: `Omniloop workflow ${verb}: ${newest.name}`, workflowId: newest.id };
  }
  const running = live.filter((workflow) => workflow.status === "running").length;
  const detail =
    running === live.length ? "running" : `${running} running, ${live.length - running} waiting`;
  return { title: `${live.length} omniloop workflows ${detail}`, workflowId: newest.id };
}
