// @effect-diagnostics nodeBuiltinImport:off - policy belongs to the executing VM.
import * as NodeFS from "node:fs";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";

type ReadConfig = () => string;
const readConstructConfig: ReadConfig = () => NodeFS.readFileSync("/etc/construct/config.env", "utf8");

/** No client or environment variable can enable this on a linked desktop/server. */
export function constructAutoApprovalEnabled(readConfig: ReadConfig = readConstructConfig): boolean {
  try {
    const config = readConfig();
    return /^AGENT_NAME=(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s'"\r\n]+)$/m.test(config) &&
      /^T3CODE_AUTO_APPROVE=(?:true|"true"|'true')$/m.test(config);
  } catch {
    return false;
  }
}

/** The command a client's Approve button sends, so the request resolves for every client. */
export function constructAutoApprovalCommand(
  stored: OrchestrationV2StoredEvent,
): Extract<OrchestrationV2ServerCommand, { readonly type: "runtime-request.respond" }> | undefined {
  if (stored.event.type !== "runtime-request.updated") return undefined;
  const request = stored.event.payload;
  // Keep questions, authentication, MCP forms and runless trust/login requests interactive.
  if (request.status !== "pending" || request.providerTurnId === null ||
      request.responseCapability.type !== "live" ||
      !["command", "file-read", "file-change", "permission"].includes(request.kind)) return undefined;
  return {
    type: "runtime-request.respond",
    // One id per request: a repeated pending update replays the first answer's receipt.
    commandId: CommandId.make(`construct-auto-approve:${request.id}`),
    threadId: stored.event.threadId,
    requestId: request.id,
    decision: "accept",
  };
}

export const autoApproveConstructRequest = Effect.fn("autoApproveConstructRequest")(
  function* (
    stored: OrchestrationV2StoredEvent,
    threads: Pick<ThreadManagement.ThreadManagementServiceShape, "dispatch">,
    readConfig?: ReadConfig,
  ) {
    const command = constructAutoApprovalCommand(stored);
    if (!command || !constructAutoApprovalEnabled(readConfig)) return;
    yield* threads.dispatch(command);
    yield* Effect.logInfo("construct.tool-permission-auto-approved", {
      requestId: command.requestId,
      threadId: command.threadId,
    });
  },
  Effect.catchCause((cause) => Effect.logWarning("construct.tool-permission-auto-approval-failed", cause)),
);

/** Answers each new pending tool approval after it is stored, through the orchestrator. */
export const constructAutoApprovalWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const afterSequence = yield* eventSink.latestSequence();
    yield* eventSink.stream({ afterSequence, eventType: "runtime-request.updated" }).pipe(
      Stream.filter((stored) => constructAutoApprovalCommand(stored) !== undefined),
      // Forked, so a busy thread's dispatch lock never delays another thread's approval.
      Stream.runForEach((stored) =>
        autoApproveConstructRequest(stored, threads).pipe(Effect.forkScoped, Effect.asVoid),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("construct.tool-permission-auto-approval-stream-failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
