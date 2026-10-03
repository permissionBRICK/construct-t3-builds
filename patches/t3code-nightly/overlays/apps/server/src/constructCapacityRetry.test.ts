import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2StoredEvent,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  announcesCapacityRetry,
  capacityNotice,
  capacityRetryAttempt,
  capacityRetryCommand,
  capacityRetryDelayMs,
  constructCapacityFailure,
  constructCapacityRetryWorkerLive,
  isCapacityFailure,
  withCapacityNotice,
} from "./constructCapacityRetry.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";

const THREAD = "thread-1" as ThreadId;
const failure = (message: string, code: string | null = null): OrchestrationV2ProviderFailure =>
  ({ class: "provider_error", message, code, retryable: null }) as OrchestrationV2ProviderFailure;
const run = (id: string, ordinal: number, userMessageId: string): OrchestrationV2Run =>
  ({
    id,
    threadId: THREAD,
    ordinal,
    userMessageId,
    rootNodeId: `node-${id}`,
    status: "failed",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  }) as unknown as OrchestrationV2Run;
const errorItem = (forRun: OrchestrationV2Run, message: string): OrchestrationV2TurnItem =>
  ({
    id: `error-${forRun.id}`,
    type: "error",
    status: "failed",
    runId: forRun.id,
    nodeId: forRun.rootNodeId,
    ordinal: 1,
    updatedAt: DateTime.makeUnsafe(0),
    failure: failure(message),
  }) as unknown as OrchestrationV2TurnItem;

describe("capacity retry policy", () => {
  it("recognizes Codex's capacity failure by text or code", () => {
    expect(isCapacityFailure(failure("Selected model is at capacity. Please try again."))).toBe(
      true,
    );
    expect(isCapacityFailure(failure("Overloaded", "serverOverloaded"))).toBe(true);
    expect(isCapacityFailure(failure("Rate limited", "rateLimitExceeded"))).toBe(false);
  });

  it("counts retries from the retry message id and backs off up to a minute", () => {
    expect(capacityRetryAttempt("message-from-user")).toBe(0);
    expect(capacityRetryAttempt("construct-capacity:3:run-9")).toBe(3);
    expect([0, 1, 2, 3, 4, 9].map(capacityRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });

  it("announces the next retry once and stops after ten", () => {
    const first = withCapacityNotice(failure("Selected model is at capacity."), 0);
    expect(first.message).toBe(
      "Selected model is at capacity. — Construct will retry this model in 5 seconds (retry 1/10).",
    );
    expect(announcesCapacityRetry(first)).toBe(true);
    expect(withCapacityNotice(first, 1)).toBe(first);
    const last = withCapacityNotice(failure("Selected model is at capacity."), 10);
    expect(last.message.endsWith(capacityNotice(10))).toBe(true);
    expect(announcesCapacityRetry(last)).toBe(false);
    expect(withCapacityNotice(failure("x".repeat(4_096)), 0).message.length).toBe(4_096);
  });

  it("retries with the failed run's model under the next attempt id", () => {
    const command = capacityRetryCommand(run("run-2", 2, "construct-capacity:1:run-1"));
    expect(command).toMatchObject({
      type: "message.dispatch",
      commandId: "construct-capacity-retry:run-2",
      messageId: "construct-capacity:2:run-2",
      threadId: THREAD,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      dispatchMode: { type: "start_immediately" },
    });
    expect(command.type === "message.dispatch" && command.text).toContain("Retry 2/10");
  });
});

describe("constructCapacityFailure", () => {
  const projections = (runs: ReadonlyArray<OrchestrationV2Run>) =>
    ({
      getThreadRecords: () => Effect.succeed({ runs }),
    }) as unknown as ProjectionStore.ProjectionStoreV2Shape;
  const capacity = failure("Selected model is at capacity.");

  it.effect("appends the notice for the failed Codex run's attempt", () =>
    Effect.gen(function* () {
      const result = yield* constructCapacityFailure(
        projections([run("run-4", 4, "construct-capacity:2:run-3")]),
        { driver: "codex", threadId: THREAD, runId: "run-4" as RunId },
        capacity,
      );
      expect(result.message).toContain("(retry 3/10)");
    }),
  );

  it.effect("leaves other drivers and unreadable runs unchanged", () =>
    Effect.gen(function* () {
      const other = yield* constructCapacityFailure(
        projections([run("run-4", 4, "m")]),
        { driver: "claudeAgent", threadId: THREAD, runId: "run-4" as RunId },
        capacity,
      );
      expect(other).toBe(capacity);
      const unreadable = yield* constructCapacityFailure(
        {
          getThreadRecords: () => Effect.die("database closed"),
        } as unknown as ProjectionStore.ProjectionStoreV2Shape,
        { driver: "codex", threadId: THREAD, runId: "run-4" as RunId },
        capacity,
      );
      expect(unreadable).toBe(capacity);
    }),
  );
});

describe("constructCapacityRetryWorkerLive", () => {
  // Lets the launched worker subscribe and reach its sleep before the clock moves.
  const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
    discard: true,
  });
  const failed = run("run-1", 1, "message-from-user");
  const announced = errorItem(
    failed,
    withCapacityNotice(failure("Selected model is at capacity."), 0).message,
  );
  const runEvent = {
    sequence: 1,
    commandId: null,
    event: { type: "run.updated", threadId: THREAD, payload: failed },
  } as unknown as OrchestrationV2StoredEvent;

  const harness = (
    records: () => { runs: OrchestrationV2Run[]; turnItems: OrchestrationV2TurnItem[] },
  ) => {
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const layer = constructCapacityRetryWorkerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EventSink.EventSinkV2, {
            latestSequence: () => Effect.succeed(0),
            stream: () => Stream.make(runEvent),
          } as unknown as EventSink.EventSinkV2Shape),
          Layer.succeed(ThreadManagement.ThreadManagementService, {
            getThreadRecords: () =>
              Effect.sync(() => ({
                thread: { id: THREAD, archivedAt: null, settledOverride: null },
                ...records(),
              })),
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Effect.sync(() => {
                dispatched.push(command);
              }),
          } as unknown as ThreadManagement.ThreadManagementServiceShape),
        ),
      ),
    );
    return { dispatched, layer };
  };

  it.effect("dispatches the retry after the announced delay", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = harness(() => ({ runs: [failed], turnItems: [announced] }));
      const fiber = yield* Layer.launch(layer).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust(Duration.millis(4_999));
      expect(dispatched).toEqual([]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* settle;
      expect(dispatched.map((command) => command.commandId)).toEqual([
        "construct-capacity-retry:run-1",
      ]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("drops the retry once the user sent another message", () =>
    Effect.gen(function* () {
      let runs = [failed];
      const { dispatched, layer } = harness(() => ({ runs, turnItems: [announced] }));
      const fiber = yield* Layer.launch(layer).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust(Duration.millis(1_000));
      runs = [failed, run("run-2", 2, "message-from-user")];
      yield* settle;
      yield* TestClock.adjust(Duration.millis(10_000));
      yield* settle;
      expect(dispatched).toEqual([]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("ignores failures that announced no retry", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = harness(() => ({
        runs: [failed],
        turnItems: [errorItem(failed, "Some other provider error")],
      }));
      const fiber = yield* Layer.launch(layer).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust(Duration.millis(60_000));
      yield* settle;
      expect(dispatched).toEqual([]);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
