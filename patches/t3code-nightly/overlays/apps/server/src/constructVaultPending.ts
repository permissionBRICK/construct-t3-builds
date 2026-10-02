// @effect-diagnostics nodeBuiltinImport:off - reads the key vault's pending notes on this VM.
import type { ConstructVaultPending, ConstructVaultPendingNote } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  parseVaultPendingNote,
  sortVaultPendingNotes,
  VAULT_PENDING_MAX_BYTES,
  VAULT_PENDING_MAX_FILES,
  vaultPendingFileId,
} from "./constructVaultPending.logic.ts";

/** Where the Construct CLI keeps one note per key vault request that waits for approval. */
export const DEFAULT_VAULT_PENDING_DIR = "/run/construct/vault-pending";

export function constructVaultPendingDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CONSTRUCT_VAULT_PENDING_DIR?.trim();
  return dir ? dir : DEFAULT_VAULT_PENDING_DIR;
}

// Never through a symlink, and never blocking on a FIFO that replaced a note
// between the listing and the open. (Both flags are 0/absent on Windows.)
const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

/** A regular file's text, or null when it is anything else or too large. */
async function readNoteText(path: string): Promise<string | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(path, OPEN_FLAGS);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > VAULT_PENDING_MAX_BYTES) return null;
    const buffer = Buffer.alloc(VAULT_PENDING_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > VAULT_PENDING_MAX_BYTES ? null : buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The valid notes in `dir`, soonest deadline first. Read-only: nothing in the
 * directory is ever written or removed. A missing or unreadable directory, or one
 * that is a symlink, has no notes.
 */
export async function listConstructVaultPending(
  dir: string,
  now: number,
): Promise<ConstructVaultPendingNote[]> {
  let entries: NodeFS.Dirent[];
  try {
    if (!(await NodeFSP.lstat(dir)).isDirectory()) return [];
    entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && vaultPendingFileId(entry.name) !== null)
    .map((entry) => entry.name)
    .sort()
    .slice(0, VAULT_PENDING_MAX_FILES);
  const notes: ConstructVaultPendingNote[] = [];
  for (const file of files) {
    const text = await readNoteText(NodePath.join(dir, file));
    const fileId = vaultPendingFileId(file);
    const note = text === null || fileId === null ? null : parseVaultPendingNote(text, fileId, now);
    if (note !== null) notes.push(note);
  }
  return sortVaultPendingNotes(notes);
}

/** The pending notes of this VM (`CONSTRUCT_VAULT_PENDING_DIR` overrides the directory). Never fails. */
export const readConstructVaultPending = (
  dir: string = constructVaultPendingDir(),
  clock: () => number = Date.now,
): Effect.Effect<ConstructVaultPending> =>
  Effect.promise(async () => {
    const now = clock();
    return { now, notes: await listConstructVaultPending(dir, now) };
  });
