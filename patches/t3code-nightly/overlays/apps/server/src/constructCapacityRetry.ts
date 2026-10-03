import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "./orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";

/**
 * Construct: retries a Codex turn that failed because the selected model was at
 * capacity, at most ten times (5 s, doubling, capped at 60 s). The failure text
 * announces the retry; a message the user sends ends the chain. The retry
 * message id carries its attempt number, so no further state is kept.
 */
export const CAPACITY_MAX_RETRIES = 10;
const CAPACITY_TEXT = /\bselected model is at capacity\b/i;
const RETRY_MESSAGE_PREFIX = "construct-capacity:";
const NOTICE_SEPARATOR = " — ";
const RETRY_NOTICE = / — Construct will retry this model in \d+ seconds \(retry \d+\/10\)\.$/;
const FAILURE_MESSAGE_MAX = 4_096;

export function isCapacityFailure(failure: OrchestrationV2ProviderFailure): boolean {
  return CAPACITY_TEXT.test(failure.message) || failure.code === "serverOverloaded";
}

/** Retries already made before this run: 0 for a run the user started. */
export function capacityRetryAttempt(userMessageId: string): number {
  if (!userMessageId.startsWith(RETRY_MESSAGE_PREFIX)) return 0;
  const attempt = Number.parseInt(userMessageId.slice(RETRY_MESSAGE_PREFIX.length), 10);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
}

export function capacityRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, 60_000);
}

export function capacityNotice(attempt: number): string {
  return attempt >= CAPACITY_MAX_RETRIES
    ? `Construct stopped after ${CAPACITY_MAX_RETRIES} automatic capacity retries. Continue manually to try again.`
    : `Construct will retry this model in ${capacityRetryDelayMs(attempt) / 1_000} seconds (retry ${attempt + 1}/${CAPACITY_MAX_RETRIES}).`;
}

export function withCapacityNotice(
  failure: OrchestrationV2ProviderFailure,
  attempt: number,
): OrchestrationV2ProviderFailure {
  if (failure.message.includes(`${NOTICE_SEPARATOR}Construct `)) return failure;
  const suffix = NOTICE_SEPARATOR + capacityNotice(attempt);
  const message = failure.message.slice(0, FAILURE_MESSAGE_MAX - suffix.length) + suffix;
  return { ...failure, message };
}

/** Whether a stored failure announced a retry, which only a Codex capacity failure does. */
export function announcesCapacityRetry(failure: OrchestrationV2ProviderFailure | null): boolean {
  return failure !== null && RETRY_NOTICE.test(failure.message);
}

export function capacityRetryCommand(run: OrchestrationV2Run): OrchestrationV2ServerCommand {
  const attempt = capacityRetryAttempt(run.userMessageId) + 1;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`construct-capacity-retry:${run.id}`),
    messageId: MessageId.make(`${RETRY_MESSAGE_PREFIX}${attempt}:${run.id}`),
    threadId: run.threadId,
    text: `[construct auto-resume] The selected model was temporarily at capacity. Retry ${attempt}/${CAPACITY_MAX_RETRIES}: continue the task from where you left off, checking any partial work first.`,
    attachments: [],
    modelSelection: run.modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/** Ingestion hook: appends the retry notice to a failed Codex turn's failure. */
export const constructCapacityFailure = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  input: { readonly driver: string; readonly threadId: ThreadId; readonly runId?: RunId | null },
  failure: OrchestrationV2ProviderFailure,
): Effect.Effect<OrchestrationV2ProviderFailure> =>
  Effect.gen(function* () {
    if (input.driver !== "codex" || !input.runId || !isCapacityFailure(failure)) return failure;
    const runId = input.runId;
    const { runs } = yield* projections.getThreadRecords(input.threadId, ["runs"], {
      runIds: [runId],
    });
    const run = runs.find((candidate) => candidate.id === runId);
    return run === undefined
      ? failure
      : withCapacityNotice(failure, capacityRetryAttempt(run.userMessageId));
  }).pipe(Effect.catchCause(() => Effect.succeed(failure)));

const makeRetryHandler = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const readRetry = (threadId: ThreadId, runId: RunId) =>
    threads
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [runId],
      })
      .pipe(
        Effect.map(({ thread, runs, turnItems }) => {
          const run = runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            thread.archivedAt !== null ||
            thread.settledOverride === "settled" ||
            // Any later run, the user's or queued, ends the chain.
            runs.some((candidate) => candidate.ordinal > run.ordinal) ||
            capacityRetryAttempt(run.userMessageId) >= CAPACITY_MAX_RETRIES ||
            !announcesCapacityRetry(latestRootProviderFailure(run, turnItems))
          )
            return null;
          return run;
        }),
      );
  return (threadId: ThreadId, runId: RunId) =>
    Effect.gen(function* () {
      const failed = yield* readRetry(threadId, runId);
      if (failed === null) return;
      yield* Effect.sleep(
        `${capacityRetryDelayMs(capacityRetryAttempt(failed.userMessageId))} millis`,
      );
      const run = yield* readRetry(threadId, runId);
      if (run === null) return;
      yield* threads.dispatch(capacityRetryCommand(run));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("construct.capacity-retry.failed", { threadId, runId, cause }),
      ),
    );
});

export const constructCapacityRetryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const retry = yield* makeRetryHandler;
    const afterSequence = yield* eventSink.latestSequence();
    yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.updated" &&
        stored.event.payload.status === "failed" &&
        stored.event.payload.threadId !== undefined
          ? retry(stored.event.payload.threadId, stored.event.payload.id).pipe(
              Effect.forkScoped,
              Effect.asVoid,
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("construct.capacity-retry.stream-failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
