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
