// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Part as OpenCodePart } from "@opencode-ai/sdk/v2";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  constructOpenCodeMonitorRoster,
  hasConstructOpenCodeMonitor,
  markConstructOpenCodeStop,
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

describe("markConstructOpenCodeStop", () => {
  it("writes the background plugin's stop marker for the session", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "construct-stop-"));
    try {
      expect(markConstructOpenCodeStop("ses_abc123", 1234, home)).toBe(true);
      const file = NodePath.join(home, "opencode", "background", "ses_abc123", "stopped");
      expect(NodeFS.readFileSync(file, "utf8")).toBe("1234");
      expect(markConstructOpenCodeStop("ses_abc123", 5678, home)).toBe(true);
      expect(NodeFS.readFileSync(file, "utf8")).toBe("5678");
      expect(markConstructOpenCodeStop("../escape", 1, home)).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(home, "opencode", "escape"))).toBe(false);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
