import type { ConstructOmniloopWorkflow, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeOmniloopWorkflows,
  extractOmniloopWorkflowIds,
  isOmniloopToolItem,
} from "./omniloopWorkflows.logic";

const toolItem = (
  id: string,
  toolName: string,
  input: unknown,
  output?: unknown,
): OrchestrationV2TurnItem =>
  ({
    id,
    type: "dynamic_tool",
    toolName,
    title: null,
    status: "completed",
    input,
    ...(output === undefined ? {} : { output }),
  }) as unknown as OrchestrationV2TurnItem;

const workflow = (
  id: string,
  status: ConstructOmniloopWorkflow["status"],
  name = id,
): ConstructOmniloopWorkflow => ({ id, name, status });

describe("extractOmniloopWorkflowIds", () => {
  it("finds ids in omniloop submit results and later status calls, oldest first", () => {
    const ids = extractOmniloopWorkflowIds([
      toolItem("1", "mcp__omniloop__submit", { script: "x" }, [
        { type: "text", text: '{"status":"started","workflow_id":"wf_V1StGXR8Z5jd"}' },
      ]),
      toolItem("2", "omniloop.status", { workflow_id: "wf_Abc123xyz789" }),
      toolItem("3", "mcp__omniloop__await", { workflow_id: "wf_V1StGXR8Z5jd" }),
    ]);
    expect(ids).toEqual(["wf_V1StGXR8Z5jd", "wf_Abc123xyz789"]);
  });

  it("ignores other tools even when they mention workflow-looking ids", () => {
    const items = [
      toolItem("1", "mcp__t3-code__preview_open", {}, "wf_NotOmniloop1"),
      {
        id: "2",
        type: "command_execution",
        input: "echo wf_NotOmniloop2",
      } as unknown as OrchestrationV2TurnItem,
    ];
    expect(items.map(isOmniloopToolItem)).toEqual([false, false]);
    expect(extractOmniloopWorkflowIds(items)).toEqual([]);
  });
});

describe("describeOmniloopWorkflows", () => {
  it("is silent once every workflow has settled", () => {
    expect(
      describeOmniloopWorkflows([workflow("wf_a", "completed"), workflow("wf_b", "failed")]),
    ).toBeNull();
    expect(describeOmniloopWorkflows([])).toBeNull();
  });

  it("names a single live workflow and links to it", () => {
    expect(describeOmniloopWorkflows([workflow("wf_a", "running", "review loop")])).toEqual({
      title: "Omniloop workflow running: review loop",
      workflowId: "wf_a",
    });
    expect(describeOmniloopWorkflows([workflow("wf_a", "paused", "review loop")])?.title).toBe(
      "Omniloop workflow paused: review loop",
    );
  });

  it("counts several live workflows and links to the newest", () => {
    const notice = describeOmniloopWorkflows([
      workflow("wf_done", "completed"),
      workflow("wf_a", "running"),
      workflow("wf_b", "pending"),
    ]);
    expect(notice).toEqual({
      title: "2 omniloop workflows 1 running, 1 waiting",
      workflowId: "wf_b",
    });
  });
});
