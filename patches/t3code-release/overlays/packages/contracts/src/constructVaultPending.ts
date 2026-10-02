import * as Schema from "effect/Schema";

/**
 * Key vault requests that wait for the user's approval on the Construct VM.
 *
 * While an agent's `construct secret …` command waits, the Construct CLI keeps a
 * note in `/run/construct/vault-pending/<id>.json`. The patched T3 server reads
 * those notes (validated; they are untrusted input) so every open client can show
 * a banner that links to the approval page. Notes hold no secret: the secret
 * names, the VM, the agent's reason, the deadline and that link.
 */
export const ConstructVaultPendingOp = Schema.Literals(["request", "get", "add", "delete"]);
export type ConstructVaultPendingOp = typeof ConstructVaultPendingOp.Type;

export const ConstructVaultPendingNote = Schema.Struct({
  id: Schema.String,
  /** The Construct instance the agent runs on. */
  vm: Schema.String,
  op: ConstructVaultPendingOp,
  /** The secret names the request is about (1 to 20). */
  names: Schema.Array(Schema.String),
  /** The agent's reason; empty when it gave none. */
  reason: Schema.String,
  /** When the request gives up waiting (epoch ms, the server's clock). */
  deadline: Schema.Number,
  /** The approval page (absolute http(s) URL); null: approve in the Companion on the PC. */
  approveUrl: Schema.NullOr(Schema.String),
});
export type ConstructVaultPendingNote = typeof ConstructVaultPendingNote.Type;

export const ConstructVaultPending = Schema.Struct({
  /** The server's clock when the notes were read (epoch ms), for the time left. */
  now: Schema.Number,
  notes: Schema.Array(ConstructVaultPendingNote),
});
export type ConstructVaultPending = typeof ConstructVaultPending.Type;

/**
 * Key vault approvals the Construct Companion on this PC waits on (T3 Desktop only).
 *
 * The Desktop main process asks the Companion's loopback IPC (`GET /v1/vault/approvals`)
 * with the bearer from the Companion's endpoint file; the token never reaches the
 * renderer. Each approval carries the exact texts of the Companion's native dialog and
 * the ids that tie it to a VM's pending note: `requestId` (the guest CLI's request id,
 * local VMs) or `hostRequestId` (the host's approval id, hosted VMs). No secret value.
 */
export const ConstructVaultDecision = Schema.Literals(["approve", "deny"]);
export type ConstructVaultDecision = typeof ConstructVaultDecision.Type;

export const ConstructVaultApproval = Schema.Struct({
  /** The Companion's approval id (1 to 128 of `A-Za-z0-9._~-`). */
  id: Schema.String,
  /** The Companion instance name. */
  instance: Schema.String,
  /** The VM name as the guest knows it. */
  vm: Schema.String,
  kind: Schema.Literals(["local", "host"]),
  /** The host slug of a hosted VM; null for a local VM. */
  host: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  hostRequestId: Schema.NullOr(Schema.String),
  op: ConstructVaultPendingOp,
  title: Schema.String,
  /** Plain text, possibly several lines. */
  message: Schema.String,
  /** The approve and deny button texts of the native dialog. */
  action: Schema.String,
  deny: Schema.String,
  names: Schema.Array(Schema.String),
  /** Epoch ms on this PC's clock. */
  createdAt: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
});
export type ConstructVaultApproval = typeof ConstructVaultApproval.Type;

/** `available: false`: no Companion, no endpoint file, or a Companion without the route. */
export const ConstructVaultApprovalsResult = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(true),
    approvals: Schema.Array(ConstructVaultApproval),
  }),
  Schema.Struct({ available: Schema.Literal(false) }),
]);
export type ConstructVaultApprovalsResult = typeof ConstructVaultApprovalsResult.Type;

/** `host-failed`: the host service refused or missed a hosted VM's decision. */
export const ConstructVaultDecideFailure = Schema.Literals([
  "already-decided",
  "not-found",
  "host-failed",
  "unavailable",
  "error",
]);
export type ConstructVaultDecideFailure = typeof ConstructVaultDecideFailure.Type;

export const ConstructVaultDecideResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: ConstructVaultDecideFailure }),
]);
export type ConstructVaultDecideResult = typeof ConstructVaultDecideResult.Type;
