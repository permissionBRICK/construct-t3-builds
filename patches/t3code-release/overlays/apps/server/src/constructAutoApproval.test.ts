import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { autoApproveConstructRequest, constructAutoApprovalEnabled } from "./constructAutoApproval";

const enabled = () => "AGENT_NAME=disposable-vm\nT3CODE_AUTO_APPROVE=true\n";
function event(overrides = {}): ProviderAdapterV2Event {
  return { type: "runtime_request.updated", runtimeRequest: {
    id: "request-1", nodeId: "node-1", providerTurnId: "turn-1", nativeRequestRef: null,
    kind: "command", status: "pending", responseCapability: { type: "live", providerSessionId: "session-1" },
    createdAt: new Date(), resolvedAt: null, ...overrides,
  }} as unknown as ProviderAdapterV2Event;
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
  it("accepts every tool approval kind once without session-wide rules", async () => {
    const responses: unknown[] = [];
    const runtime = { respondToRuntimeRequest: (input: unknown) => Effect.sync(() => { responses.push(input); }) };
    for (const kind of ["command", "file-read", "file-change", "permission"]) {
      await Effect.runPromise(autoApproveConstructRequest(event({ kind }), runtime, enabled));
    }
    expect(responses).toEqual(Array(4).fill({ requestId: "request-1", decision: "accept" }));
  });
  it("keeps questions, auth, trust, MCP forms and completed requests interactive", async () => {
    let calls = 0;
    const runtime = { respondToRuntimeRequest: () => Effect.sync(() => { calls++; }) };
    for (const overrides of [{ kind: "user_input" }, { kind: "auth_refresh" }, { kind: "mcp-elicitation" }, { kind: "dynamic_tool_call" }, { providerTurnId: null }, { status: "resolved" }, { status: "cancelled" }, { responseCapability: { type: "not_resumable", reason: "lost" } }]) {
      await Effect.runPromise(autoApproveConstructRequest(event(overrides), runtime, enabled));
    }
    await Effect.runPromise(autoApproveConstructRequest(event(), runtime, () => ""));
    expect(calls).toBe(0);
  });
  it("does not stop event processing if a response fails", async () => {
    await Effect.runPromise(autoApproveConstructRequest(event(), { respondToRuntimeRequest: () => Effect.fail(new Error("provider disconnected")) } as never, enabled));
  });
  it("reads the setting again for each new request", async () => {
    let config = enabled(); let calls = 0;
    const runtime = { respondToRuntimeRequest: () => Effect.sync(() => { calls++; }) };
    await Effect.runPromise(autoApproveConstructRequest(event(), runtime, () => config));
    config = config.replace("true", "false");
    await Effect.runPromise(autoApproveConstructRequest(event({ id: "request-2" }), runtime, () => config));
    expect(calls).toBe(1);
  });
});
