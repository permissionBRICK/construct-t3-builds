import * as Schema from "effect/Schema";

/**
 * The new Construct's update as the VM sees it (the T3 web UI without the Desktop app, a
 * phone for example). The patched T3 server asks the VM's guest CLI: `construct update status
 * --json` prints its engine's `GET /vms/{name}/update` answer, `construct update run --json`
 * its `POST` answer, which updates the VM and, when the VM's owner administers the host, the
 * host first. A VM without those commands, or one that fails, has nothing to show.
 */
export const ConstructVmUpdate = Schema.Struct({
  /** A newer payload or a host release is on offer. */
  available: Schema.Boolean,
  /** This server started the update in the last half hour and the VM has not moved yet. */
  running: Schema.Boolean,
  /** The host release on offer, else the payload commit (short); null when none is named. */
  version: Schema.NullOr(Schema.String),
  /** The offer includes the host's own update. */
  host: Schema.Boolean,
  /** The payload the VM runs now (short commit); null when unknown. */
  appliedCommit: Schema.NullOr(Schema.String),
});
export type ConstructVmUpdate = typeof ConstructVmUpdate.Type;

export const ConstructVmUpdateRun = Schema.Struct({
  started: Schema.Boolean,
  /** Why it did not start; null when it did. */
  message: Schema.NullOr(Schema.String),
});
export type ConstructVmUpdateRun = typeof ConstructVmUpdateRun.Type;
