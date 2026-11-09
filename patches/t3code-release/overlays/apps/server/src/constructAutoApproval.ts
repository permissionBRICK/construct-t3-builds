// @effect-diagnostics nodeBuiltinImport:off - policy belongs to the executing VM.
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import type { ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";

/** No client or environment variable can enable this on a linked desktop/server. */
export function constructAutoApprovalEnabled(readConfig: () => string = () => readFileSync("/etc/construct/config.env", "utf8")): boolean {
  try {
    const config = readConfig();
    return /^AGENT_NAME=(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s'"\r\n]+)$/m.test(config) &&
      /^T3CODE_AUTO_APPROVE=(?:true|"true"|'true')$/m.test(config);
  } catch {
    return false;
  }
}

export function constructAutoApprovalRequest(event: ProviderAdapterV2Event) {
  if (event.type !== "runtime_request.updated") return undefined;
  const request = event.runtimeRequest;
  // Keep questions, authentication, MCP forms and runless trust/login requests interactive.
  if (request.status !== "pending" || request.providerTurnId === null ||
      request.responseCapability.type !== "live" ||
      !["command", "file-read", "file-change", "permission"].includes(request.kind)) return undefined;
  return request;
}

export const autoApproveConstructRequest = Effect.fn("autoApproveConstructRequest")(
  function* (
    event: ProviderAdapterV2Event,
    runtime: Pick<ProviderAdapterV2SessionRuntime, "respondToRuntimeRequest">,
    readConfig?: () => string,
  ) {
    const request = constructAutoApprovalRequest(event);
    if (!request || !constructAutoApprovalEnabled(readConfig)) return;
    yield* runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" });
    yield* Effect.logInfo("construct.tool-permission-auto-approved", { requestId: request.id, kind: request.kind });
  },
  Effect.catchCause((cause) => Effect.logWarning("construct.tool-permission-auto-approval-failed", cause)),
);
