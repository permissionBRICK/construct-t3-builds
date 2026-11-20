import type { Part as OpenCodePart } from "@opencode-ai/sdk/v2";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  constructOpenCodeMonitorRoster,
  hasConstructOpenCodeMonitor,
  makeConstructOpenCode2Monitors,
  withoutConstructOpenCodeMonitors,
} from "./constructOpenCodeMonitor.ts";

const tool = (name: string, metadata: Record<string, unknown>, title = "watch CI") =>
  ({
    type: "tool",
    tool: name,
    state: {
      status: "completed",
      title,
      metadata,
      input: {},
      output: "",
      time: { start: 0, end: 1 },
    },
  }) as unknown as OpenCodePart;
const text = (value: string) => ({ type: "text", text: value }) as unknown as OpenCodePart;
const monitor = { taskId: "bg_1", kind: "monitor" as const, description: "watch CI" };

describe("constructOpenCodeMonitorRoster", () => {
  it("arms a waiting background task as a monitor once", () => {
    expect(
      constructOpenCodeMonitorRoster([], tool("background", { id: " bg_1 ", wait: true }), false),
    ).toEqual([monitor]);
    expect(
      constructOpenCodeMonitorRoster(
        [monitor],
        tool("background", { id: "bg_1", wait: true }),
        false,
      ),
    ).toBeNull();
    expect(
      constructOpenCodeMonitorRoster([], tool("background", { id: "bg_2" }), false),
    ).toBeNull();
  });

  it("ends a monitor on its wake message or on background_kill", () => {
    const wake = text('<background-task id="bg_1" status="completed">\nCI passed');
    expect(constructOpenCodeMonitorRoster([monitor], wake, true)).toEqual([]);
    expect(constructOpenCodeMonitorRoster([monitor], wake, false)).toBeNull();
    expect(
      constructOpenCodeMonitorRoster([monitor], tool("background_kill", { id: "bg_1" }), false),
    ).toEqual([]);
    expect(
      constructOpenCodeMonitorRoster([monitor], tool("background_kill", { id: "bg_9" }), false),
    ).toBeNull();
  });

  it("ignores other parts", () => {
    expect(constructOpenCodeMonitorRoster([monitor], text("hello"), true)).toBeNull();
    expect(
      constructOpenCodeMonitorRoster([monitor], tool("bash", { id: "bg_1" }), false),
    ).toBeNull();
  });
});

describe("monitor probes", () => {
  const thread = (
    pendingBackgroundTasks: OrchestrationV2ProviderThread["pendingBackgroundTasks"],
  ) => ({ pendingBackgroundTasks }) as OrchestrationV2ProviderThread;

  it("reports and clears only monitors", () => {
    const command = { taskId: "cmd_1", kind: "command" as const };
    expect(hasConstructOpenCodeMonitor(thread([monitor, command]))).toBe(true);
    expect(hasConstructOpenCodeMonitor(thread([command]))).toBe(false);
    expect(hasConstructOpenCodeMonitor(undefined)).toBe(false);
    expect(withoutConstructOpenCodeMonitors(thread([monitor, command]))).toEqual([command]);
  });
});

describe("makeConstructOpenCode2Monitors", () => {
  const armed = { id: "bg_1", pid: 42, wait: true, description: " watch CI " };
  const root = { sessionId: "ses_root" };
  const child = { sessionId: "ses_child" };

  it("arms a waiting background call as a monitor of its session once", () => {
    const monitors = makeConstructOpenCode2Monitors();
    expect(monitors.tool("ses_root", "background", armed)).toBe(true);
    expect(monitors.tool("ses_root", "background", armed)).toBe(false);
    expect(monitors.tool("ses_root", "background", { id: "bg_2", wait: false })).toBe(false);
    expect(monitors.tool("ses_root", "shell", { id: "bg_3", wait: true })).toBe(false);
    expect(monitors.has("ses_root")).toBe(true);
    expect(monitors.tasks([root])).toEqual([monitor]);
  });

  it("ends a monitor on its wake or on background_kill, in its own session only", () => {
    const monitors = makeConstructOpenCode2Monitors();
    monitors.tool("ses_root", "background", armed);
    monitors.tool("ses_child", "background", { id: "bg_1", wait: true });
    expect(monitors.tasks([root, child])).toHaveLength(2);
    expect(monitors.wake("ses_root", { source: "shell", id: "bg_1" })).toBe(false);
    expect(monitors.wake("ses_root", { source: "construct-background", id: "bg_1" })).toBe(true);
    expect(monitors.has("ses_root")).toBe(false);
    expect(monitors.tasks([root, child])).toEqual([{ taskId: "bg_1", kind: "monitor" }]);
    expect(monitors.tool("ses_child", "background_kill", { id: "bg_9" })).toBe(false);
    expect(monitors.tool("ses_child", "background_kill", { id: "bg_1" })).toBe(true);
    expect(monitors.tasks([root, child])).toEqual([]);
  });

  it("clears the monitors of stopped sessions", () => {
    const monitors = makeConstructOpenCode2Monitors();
    monitors.tool("ses_root", "background", armed);
    expect(monitors.clear([child])).toBe(false);
    expect(monitors.clear([root, child])).toBe(true);
    expect(monitors.has("ses_root")).toBe(false);
  });
});
