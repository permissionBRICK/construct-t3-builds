import type { ConstructVaultPending } from "@t3tools/contracts";

/** At most this many requests are listed; the rest are counted ("and 2 more"). */
export const VAULT_BANNER_VISIBLE_REQUESTS = 3;
/** At most this many secret names are spelled out per request. */
export const VAULT_BANNER_VISIBLE_NAMES = 3;
export const VAULT_COMPANION_HINT = "Approve it in the Construct Companion on your PC.";

/** One environment's last answer and when it arrived (the client's clock, epoch ms). */
export interface ConstructVaultPendingReading {
  readonly environmentLabel: string;
  readonly pending: ConstructVaultPending;
  readonly receivedAt: number;
}

export interface ConstructVaultBannerItem {
  readonly key: string;
  readonly names: string;
  /** "The agent on <vm> · <reason> · <time left>". */
  readonly detail: string;
  /** The approval page, or null: approve in the Companion on the PC. */
  readonly approveUrl: string | null;
}

export interface ConstructVaultBanner {
  readonly title: string;
  /** The requests shown, most urgent first (at most three). */
  readonly items: ReadonlyArray<ConstructVaultBannerItem>;
  /** Several requests wait: each item names its secrets (one request names them in the title). */
  readonly listed: boolean;
  /** "and N more" when more requests wait than are listed. */
  readonly more: string | null;
  /** Shown when a listed request has no approval link. */
  readonly companionHint: string | null;
  /** Every waiting request's key, listed or not: what hiding the banner silences. */
  readonly keys: ReadonlyArray<string>;
  /** Changes whenever anything the banner shows changes. */
  readonly signature: string;
}

export function formatVaultTimeLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours} h left` : `${hours} h ${minutes % 60} min left`;
  return `${Math.floor(hours / 24)} d left`;
}

export function formatVaultNames(names: ReadonlyArray<string>): string {
  if (names.length <= VAULT_BANNER_VISIBLE_NAMES) return names.join(", ");
  const shown = names.slice(0, VAULT_BANNER_VISIBLE_NAMES).join(", ");
  return `${shown} and ${names.length - VAULT_BANNER_VISIBLE_NAMES} more`;
}

/** A request is the same on every connection to its VM. */
export function constructVaultPendingKey(vm: string, id: string): string {
  return `${vm}\n${id}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The banner for the requests the connected Construct VMs report, or null when
 * none waits or the user hid every one that does. `clientNow` is the client's
 * clock; time left is measured on each server's clock (its `now`, advanced by
 * the time since the answer arrived), so a phone with a wrong clock still counts
 * down correctly.
 */
export function buildConstructVaultBanner(
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
  hiddenKeys: ReadonlySet<string>,
): ConstructVaultBanner | null {
  const waiting: Array<{
    readonly key: string;
    readonly left: number;
    readonly vm: string;
    readonly names: ReadonlyArray<string>;
    readonly reason: string;
    readonly approveUrl: string | null;
  }> = [];
  const seen = new Set<string>();
  for (const reading of readings) {
    const serverNow = reading.pending.now + Math.max(0, clientNow - reading.receivedAt);
    for (const note of reading.pending.notes) {
      const key = constructVaultPendingKey(note.vm, note.id);
      const left = note.deadline - serverNow;
      if (left <= 0 || seen.has(key)) continue;
      seen.add(key);
      waiting.push({
        key,
        left,
        vm: note.vm === "" ? reading.environmentLabel : note.vm,
        names: note.names,
        reason: note.reason,
        approveUrl: note.approveUrl,
      });
    }
  }
  if (waiting.every((request) => hiddenKeys.has(request.key))) return null;
  waiting.sort((a, b) => a.left - b.left || compareText(a.key, b.key));

  const items = waiting
    .slice(0, VAULT_BANNER_VISIBLE_REQUESTS)
    .map((request): ConstructVaultBannerItem => ({
      key: request.key,
      names: formatVaultNames(request.names),
      detail: [`The agent on ${request.vm}`, request.reason, formatVaultTimeLeft(request.left)]
        .filter((part) => part !== "")
        .join(" · "),
      approveUrl: request.approveUrl,
    }));
  const listed = waiting.length > 1;
  const title = listed
    ? `Key vault: ${waiting.length} requests waiting for your approval`
    : `Key vault: ${items[0]!.names} waiting for your approval`;
  const hidden = waiting.length - items.length;
  const more = hidden > 0 ? `and ${hidden} more` : null;
  const companionHint = items.some((item) => item.approveUrl === null)
    ? VAULT_COMPANION_HINT
    : null;
  return {
    title,
    items,
    listed,
    more,
    companionHint,
    keys: waiting.map((request) => request.key),
    signature: JSON.stringify([title, items, more, companionHint]),
  };
}
