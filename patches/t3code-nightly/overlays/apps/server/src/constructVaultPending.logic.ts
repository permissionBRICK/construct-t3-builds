import type { ConstructVaultPendingNote, ConstructVaultPendingOp } from "@t3tools/contracts";

/**
 * Validation of the key vault's pending notes. The files are untrusted input: a
 * note that breaks any rule is ignored as a whole, never repaired.
 */

/** At most this many note files are read per call. */
export const VAULT_PENDING_MAX_FILES = 50;
/** A note file larger than this is ignored. */
export const VAULT_PENDING_MAX_BYTES = 4096;
/** A note naming more secrets than this is ignored. */
export const VAULT_PENDING_MAX_NAMES = 20;
/** `vm` and `reason` are clipped to this many characters. */
export const VAULT_PENDING_TEXT_LIMIT = 100;

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NOTE_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const OPS: ReadonlySet<string> = new Set<ConstructVaultPendingOp>([
  "request",
  "get",
  "add",
  "delete",
]);

/** The note id a directory entry names, or null for anything else (temp files start with "."). */
export function vaultPendingFileId(fileName: string): string | null {
  return NOTE_FILE.exec(fileName)?.[1] ?? null;
}

/** Control characters become spaces, runs of whitespace one space; clipped to the limit. */
export function clipVaultText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, VAULT_PENDING_TEXT_LIMIT).join("").trim();
}

/** An absolute http(s) URL, or null for anything else. */
export function vaultApproveUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One note file's content, validated against the contract. `fileId` is the id its
 * file name carries; `now` is epoch ms. Null when the note must be ignored.
 */
export function parseVaultPendingNote(
  text: string,
  fileId: string,
  now: number,
): ConstructVaultPendingNote | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const { id, vm, op, names, reason, deadline } = value;
  if (typeof id !== "string" || !NOTE_ID.test(id) || id !== fileId) return null;
  if (typeof vm !== "string") return null;
  if (typeof op !== "string" || !OPS.has(op)) return null;
  if (!Array.isArray(names) || names.length === 0 || names.length > VAULT_PENDING_MAX_NAMES)
    return null;
  if (!names.every((name) => typeof name === "string" && SECRET_NAME.test(name))) return null;
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= now) return null;
  return {
    id,
    vm: clipVaultText(vm),
    op: op as ConstructVaultPendingOp,
    names: names as string[],
    reason: clipVaultText(reason),
    deadline,
    approveUrl: vaultApproveUrl(value.approveUrl),
  };
}

/** Soonest deadline first; the id breaks ties so the order is stable. */
export function sortVaultPendingNotes(
  notes: ReadonlyArray<ConstructVaultPendingNote>,
): ConstructVaultPendingNote[] {
  return [...notes].sort(
    (a, b) => a.deadline - b.deadline || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
