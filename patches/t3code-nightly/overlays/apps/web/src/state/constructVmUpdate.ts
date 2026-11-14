import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand, runInEnvironment } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The new Construct's update of the VM the environment's T3 server runs on. */
export const readConstructVmUpdate = createRuntimeCommand(connectionAtomRuntime, {
  label: "construct-vm-update:status",
  execute: (target: { readonly environmentId: EnvironmentId }) =>
    runInEnvironment(target.environmentId, request(WS_METHODS.constructVmUpdateStatus, {})),
});

/** Start it: the VM updates (and its host, for an owner who administers it). */
export const runConstructVmUpdate = createRuntimeCommand(connectionAtomRuntime, {
  label: "construct-vm-update:run",
  execute: (target: { readonly environmentId: EnvironmentId }) =>
    runInEnvironment(target.environmentId, request(WS_METHODS.constructVmUpdateRun, {})),
});
