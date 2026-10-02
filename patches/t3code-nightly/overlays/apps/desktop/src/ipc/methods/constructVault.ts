import { ConstructVaultApprovalsResult, ConstructVaultDecideResult } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ConstructVaultApprovals from "../../construct/ConstructVaultApprovals.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const optionalEnv = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.getOrUndefined),
  );

const companionOptions = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return {
    platform: environment.platform,
    localAppData: yield* optionalEnv("LOCALAPPDATA"),
    temp: yield* optionalEnv("TEMP"),
  } satisfies ConstructVaultApprovals.ConstructVaultCompanionOptions;
});

/** The key vault approvals the Construct Companion on this PC waits on. */
export const constructVaultApprovals = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONSTRUCT_VAULT_APPROVALS_CHANNEL,
  payload: Schema.Void,
  result: ConstructVaultApprovalsResult,
  handler: Effect.fn("desktop.ipc.constructVault.approvals")(function* () {
    const options = yield* companionOptions;
    return yield* Effect.promise(() =>
      ConstructVaultApprovals.listConstructVaultApprovals(options),
    );
  }),
});

/** Approve or deny one of them; the id and decision are validated in the main process. */
export const constructVaultDecide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONSTRUCT_VAULT_DECIDE_CHANNEL,
  payload: Schema.Struct({ id: Schema.String, decision: Schema.String }),
  result: ConstructVaultDecideResult,
  handler: Effect.fn("desktop.ipc.constructVault.decide")(function* (input) {
    const options = yield* companionOptions;
    return yield* Effect.promise(() =>
      ConstructVaultApprovals.decideConstructVaultApproval(input.id, input.decision, options),
    );
  }),
});
