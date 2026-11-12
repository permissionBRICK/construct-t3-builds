import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ServerCommand, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { autoApproveConstructRequest, constructAutoApprovalEnabled } from "./constructAutoApproval.ts";
import { OrchestratorDispatchError } from "./orchestration-v2/Orchestrator.ts";

const enabled = () => "AGENT_NAME=disposable-vm\nT3CODE_AUTO_APPROVE=true\n";
function stored(overrides = {}): OrchestrationV2StoredEvent {
  return { sequence: 7, commandId: null, event: {
    type: "runtime-request.updated", threadId: "thread-1", payload: {
      id: "request-1", nodeId: "node-1", providerTurnId: "turn-1", nativeRequestRef: null,
      kind: "command", status: "pending", responseCapability: { type: "live", providerSessionId: "session-1" },
      createdAt: "2026-11-01T00:00:00.000Z", resolvedAt: null, ...overrides,
    },
  }} as unknown as OrchestrationV2StoredEvent;
}
function orchestrator() {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  return { dispatched, threads: { dispatch: (command: OrchestrationV2ServerCommand) => Effect.sync(() => { dispatched.push(command); }) } as never };
}

describe("Construct server tool approval policy", () => {
  it("requires the local Construct config and exact opt-in", () => {
    expect(constructAutoApprovalEnabled(enabled)).toBe(true);
    for (const config of ["", "AGENT_NAME=vm", "T3CODE_AUTO_APPROVE=true", enabled().replace("true", "false"), enabled().replace("true", "yes"), enabled().replace("AGENT_NAME=disposable-vm", "AGENT_NAME=")]) {
      expect(constructAutoApprovalEnabled(() => config)).toBe(false);
    }
    expect(constructAutoApprovalEnabled(() => { throw new Error("ENOENT"); })).toBe(false);
    expect(constructAutoApprovalEnabled(() => "AGENT_NAME='vm'\nT3CODE_AUTO_APPROVE='true'\n")).toBe(true);
  });
  it.effect("accepts every tool approval kind through the orchestrator, once per request", () => Effect.gen(function* () {
    const { dispatched, threads } = orchestrator();
    for (const kind of ["command", "file-read", "file-change", "permission"]) {
      yield* autoApproveConstructRequest(stored({ kind }), threads, enabled);
    }
    expect(dispatched).toEqual(Array.from({ length: 4 }, () => ({
      type: "runtime-request.respond", commandId: "construct-auto-approve:request-1",
      threadId: "thread-1", requestId: "request-1", decision: "accept",
    })));
  }));
  it.effect("keeps questions, auth, trust, MCP forms and completed requests interactive", () => Effect.gen(function* () {
    const { dispatched, threads } = orchestrator();
    for (const overrides of [{ kind: "user_input" }, { kind: "auth_refresh" }, { kind: "mcp-elicitation" }, { kind: "dynamic_tool_call" }, { providerTurnId: null }, { status: "resolved" }, { status: "cancelled" }, { responseCapability: { type: "message" } }, { responseCapability: { type: "not_resumable", reason: "lost" } }]) {
      yield* autoApproveConstructRequest(stored(overrides), threads, enabled);
    }
    yield* autoApproveConstructRequest(stored(), threads, () => "");
    expect(dispatched).toEqual([]);
  }));
  it.effect("does not stop event processing if the orchestrator rejects the answer", () =>
    autoApproveConstructRequest(stored(), { dispatch: () => Effect.fail(new OrchestratorDispatchError({ commandId: "construct-auto-approve:request-1", commandType: "runtime-request.respond", cause: "Runtime request request-1 is resolved." } as never)) } as never, enabled));
  it.effect("reads the setting again for each new request", () => Effect.gen(function* () {
    let config = enabled();
    const { dispatched, threads } = orchestrator();
    yield* autoApproveConstructRequest(stored(), threads, () => config);
    config = config.replace("true", "false");
    yield* autoApproveConstructRequest(stored({ id: "request-2" }), threads, () => config);
    expect(dispatched.map((command) => command.commandId)).toEqual(["construct-auto-approve:request-1"]);
  }));
});
