import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand, runInEnvironment } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Key vault requests waiting for the user's approval on the environment's Construct VM. */
export const readConstructVaultPending = createRuntimeCommand(connectionAtomRuntime, {
  label: "construct-vault-pending:read",
  execute: (target: { readonly environmentId: EnvironmentId }) =>
    runInEnvironment(target.environmentId, request(WS_METHODS.constructVaultPending, {})),
});
