import type {
  ConstructVaultApproval,
  ConstructVaultDecideResult,
  ConstructVaultDecision,
  ConstructVaultPending,
  ConstructVaultPendingNote,
} from "@t3tools/contracts";

/** At most this many requests are listed; the rest are counted ("and 2 more"). */
export const VAULT_BANNER_VISIBLE_REQUESTS = 3;
/** At most this many secret names are spelled out per request. */
export const VAULT_BANNER_VISIBLE_NAMES = 3;
export const VAULT_COMPANION_HINT = "Approve it in the Construct Companion on your PC.";
/** Approve is enabled this long after an approval shows, like the Companion's own dialog. */
export const VAULT_APPROVE_ARM_MS = 1_000;
/** A decision's result line stays this long. */
export const VAULT_RESULT_VISIBLE_MS = 5_000;
/**
 * A VM's note stays tied to a Companion approval this long after the Companion last
 * listed it: answered on the PC, phone or host, the approval leaves the Companion's
 * list before the VM's CLI learns the answer and removes its note.
 */
export const VAULT_MATCH_GRACE_MS = 15_000;
/** The servers, and the Companion, are asked this often while the page is visible. */
export const VAULT_POLL_INTERVAL_MS = 3_000;
/**
 * In the Desktop app, a VM note no Companion approval matches yet is held back this long
 * after the banner first saw it: the Companion learns of a hosted VM's request only on its
 * next host poll, seconds after the VM wrote its note. The request then shows once, as the
 * Companion item, instead of first as a link; without a match it shows after the hold.
 */
export const VAULT_NOTE_HOLD_MS = 10_000;
/** While a note is held back, the Companion is asked this often. */
export const VAULT_HOLD_POLL_INTERVAL_MS = 1_000;

/** One environment's last answer and when it arrived (the client's clock, epoch ms). */
export interface ConstructVaultPendingReading {
  readonly environmentLabel: string;
  readonly pending: ConstructVaultPending;
  readonly receivedAt: number;
}

/** A Companion approval the Companion listed, and when it last did (client clock). */
export interface ConstructVaultRecentApproval {
  readonly approval: ConstructVaultApproval;
  readonly lastSeen: number;
}

export interface ConstructVaultResultLine {
  readonly text: string;
  readonly at: number;
  /** The decision is still being sent: the line stays until it is answered. */
  readonly pending: boolean;
}

/**
 * What the banner knows about the Construct Companion on this PC (Desktop app only).
 * The approvals are the Companion's current list, never a copy of an item it no longer
 * lists.
 */
export interface ConstructVaultCompanionView {
  readonly approvals: ReadonlyArray<ConstructVaultApproval>;
  /** Approvals listed within the grace period: they still claim their VM notes. */
  readonly recent: ReadonlyMap<string, ConstructVaultRecentApproval>;
  /** Approvals the user decided in this banner: hidden at once (optimistically). */
  readonly decided: ReadonlySet<string>;
  /** When each shown approval first showed (client clock); Approve arms after that. */
  readonly shownSince: ReadonlyMap<string, number>;
  /** A decision is being sent: every button waits. */
  readonly busy: boolean;
  readonly result: ConstructVaultResultLine | null;
  /** The Companion answered its last poll (before its first answer it counts as available). */
  readonly available: boolean;
  /** When the banner first saw each VM note (client clock), by note key. */
  readonly notesFirstSeen: ReadonlyMap<string, number>;
}

export interface ConstructVaultBannerNoteItem {
  readonly kind: "note";
  readonly key: string;
  readonly names: string;
  /** "The agent on <vm> · <reason> · <time left>". */
  readonly detail: string;
  /** The approval page, or null: approve in the Companion on the PC. */
  readonly approveUrl: string | null;
}

export interface ConstructVaultBannerApprovalItem {
  readonly kind: "approval";
  readonly key: string;
  /** The Companion's approval id, for the decision. */
  readonly id: string;
  readonly names: string;
  /** The texts of the Companion's own dialog (plain text). */
  readonly title: string;
  readonly message: string;
  /** "The agent on <vm> · <time left>". */
  readonly detail: string;
  readonly approveLabel: string;
  readonly denyLabel: string;
  /** Approve is enabled (shown for at least a second). */
  readonly armed: boolean;
}

export type ConstructVaultBannerItem =
  | ConstructVaultBannerNoteItem
  | ConstructVaultBannerApprovalItem;

export interface ConstructVaultBanner {
  readonly title: string;
  /** The requests shown, most urgent first (at most three). */
  readonly items: ReadonlyArray<ConstructVaultBannerItem>;
  /** Several requests wait: each note item names its secrets (one request names them in the title). */
  readonly listed: boolean;
  /** "and N more" when more requests wait than are listed. */
  readonly more: string | null;
  /** Shown when a listed note has no approval link. */
  readonly companionHint: string | null;
  /** The last decision made in the banner. */
  readonly result: string | null;
  /** A decision is being sent: the buttons wait. */
  readonly busy: boolean;
  /** Every waiting request's key, listed or not: what hiding the banner silences. */
  readonly keys: ReadonlyArray<string>;
  /** When the banner changes by itself next (Approve arms, the result line ends), or null. */
  readonly nextChangeAt: number | null;
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

/** A Companion approval's key; the NUL keeps it apart from every VM note's key. */
export function constructVaultApprovalKey(id: string): string {
  return `\u0000companion\n${id}`;
}

/** The `request=<id>` value in an approval link's fragment, or null. */
export function vaultApproveUrlRequest(approveUrl: string | null): string | null {
  if (approveUrl === null) return null;
  const hash = approveUrl.indexOf("#");
  if (hash < 0) return null;
  const value = new URLSearchParams(approveUrl.slice(hash + 1)).get("request");
  return value === null || value === "" ? null : value;
}

/** A VM note and a Companion approval are the same request (local or hosted VM). */
export function vaultNoteMatchesApproval(
  note: Pick<ConstructVaultPendingNote, "id" | "approveUrl">,
  approval: Pick<ConstructVaultApproval, "requestId" | "hostRequestId">,
): boolean {
  if (approval.requestId !== null && note.id === approval.requestId) return true;
  return (
    approval.hostRequestId !== null &&
    vaultApproveUrlRequest(note.approveUrl) === approval.hostRequestId
  );
}

/** The recent approvals after a Companion answer: the listed ones now, older ones expire. */
export function rememberVaultApprovals(
  recent: ReadonlyMap<string, ConstructVaultRecentApproval>,
  approvals: ReadonlyArray<ConstructVaultApproval>,
  clientNow: number,
): Map<string, ConstructVaultRecentApproval> {
  const next = new Map<string, ConstructVaultRecentApproval>();
  for (const [id, entry] of recent) {
    if (clientNow - entry.lastSeen < VAULT_MATCH_GRACE_MS) next.set(id, entry);
  }
  for (const approval of approvals) next.set(approval.id, { approval, lastSeen: clientNow });
  return next;
}

/** When the banner first saw each note the readings list now, and whether one is new. */
export function rememberVaultNotesSeen(
  firstSeen: ReadonlyMap<string, number>,
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
): { readonly firstSeen: Map<string, number>; readonly added: boolean } {
  const next = new Map<string, number>();
  let added = false;
  for (const reading of readings) {
    for (const note of reading.pending.notes) {
      const key = constructVaultPendingKey(note.vm, note.id);
      if (next.has(key)) continue;
      const since = firstSeen.get(key);
      if (since === undefined) added = true;
      next.set(key, since ?? clientNow);
    }
  }
  return { firstSeen: next, added };
}

/** The decided approvals the Companion still lists; the others are gone for good. */
export function settleVaultDecided(
  decided: ReadonlySet<string>,
  approvals: ReadonlyArray<ConstructVaultApproval>,
): Set<string> {
  const listed = new Set(approvals.map((approval) => approval.id));
  return new Set([...decided].filter((id) => listed.has(id)));
}

/** Approve may be clicked: the approval has shown for at least a second. */
export function isVaultApproveArmed(shownSince: number | undefined, clientNow: number): boolean {
  return shownSince !== undefined && clientNow - shownSince >= VAULT_APPROVE_ARM_MS;
}

/** A decision the Companion took (or one that no longer matters): the item stays hidden. */
export function vaultDecisionSettles(result: ConstructVaultDecideResult): boolean {
  return result.ok || result.reason === "already-decided" || result.reason === "not-found";
}

function approvalVm(approval: ConstructVaultApproval): string {
  return approval.vm !== "" ? approval.vm : approval.instance;
}

/** The result line for a decision on one approval, while it is sent and once answered. */
export function vaultDecisionResultText(
  approval: ConstructVaultApproval,
  decision: ConstructVaultDecision,
  result: ConstructVaultDecideResult | "pending",
): string {
  const what = `${formatVaultNames(approval.names)} for ${approvalVm(approval)}`;
  if (result === "pending")
    return decision === "approve" ? `Approving ${what}…` : `Denying ${what}…`;
  if (result.ok) return decision === "approve" ? `Approved ${what}.` : `Denied ${what}.`;
  switch (result.reason) {
    case "already-decided":
      return `${what} was already answered elsewhere.`;
    case "not-found":
      return `${what} is no longer waiting.`;
    case "host-failed":
      return `The host could not be reached for ${what}. Try again, or answer in the Companion.`;
    case "unavailable":
      return `The Construct Companion is not reachable. ${what} still waits.`;
    case "error":
      return `Could not send the decision for ${what}. Try again, or answer in the Companion.`;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type WaitingEntry =
  | {
      readonly kind: "note";
      readonly key: string;
      readonly left: number;
      readonly names: ReadonlyArray<string>;
      readonly vm: string;
      readonly reason: string;
      readonly approveUrl: string | null;
    }
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly left: number;
      readonly names: ReadonlyArray<string>;
      readonly approval: ConstructVaultApproval;
    };

/**
 * The banner for the requests the connected Construct VMs report and, in the Desktop
 * app, the approvals the Construct Companion on this PC waits on; null when none waits
 * or the user hid every one that does. A VM note that is a Companion approval is shown
 * once, as the approval; while the Companion answers, a note it does not list yet is held
 * back for `VAULT_NOTE_HOLD_MS` after it was first seen. `clientNow` is the client's
 * clock; a note's time left is measured on its server's clock (its `now`, advanced by the
 * time since the answer arrived), so a phone with a wrong clock still counts down
 * correctly. A Companion approval runs on this PC's clock.
 */
export function buildConstructVaultBanner(
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
  hiddenKeys: ReadonlySet<string>,
  companion: ConstructVaultCompanionView | null = null,
): ConstructVaultBanner | null {
  const { waiting } = collectVaultWaiting(readings, clientNow, companion);
  const lastResult = companion?.result ?? null;
  const resultLine =
    lastResult !== null &&
    (lastResult.pending || clientNow - lastResult.at < VAULT_RESULT_VISIBLE_MS)
      ? lastResult
      : null;
  if (everyVaultRequestHidden(waiting, hiddenKeys)) return null;
  if (waiting.length === 0 && resultLine === null) return null;
  waiting.sort((a, b) => a.left - b.left || compareText(a.key, b.key));

  const busy = companion?.busy === true;
  let nextChangeAt: number | null =
    resultLine === null || resultLine.pending ? null : resultLine.at + VAULT_RESULT_VISIBLE_MS;
  const soonest = (at: number) => {
    nextChangeAt = nextChangeAt === null ? at : Math.min(nextChangeAt, at);
  };
  const items = waiting
    .slice(0, VAULT_BANNER_VISIBLE_REQUESTS)
    .map((request): ConstructVaultBannerItem => {
      const names = formatVaultNames(request.names);
      const timeLeft = request.left === Infinity ? "" : formatVaultTimeLeft(request.left);
      if (request.kind === "note") {
        return {
          kind: "note",
          key: request.key,
          names,
          detail: [`The agent on ${request.vm}`, request.reason, timeLeft]
            .filter((part) => part !== "")
            .join(" · "),
          approveUrl: request.approveUrl,
        };
      }
      const { approval } = request;
      const shownSince = companion?.shownSince.get(approval.id);
      const armed = isVaultApproveArmed(shownSince, clientNow);
      if (!armed) soonest((shownSince ?? clientNow) + VAULT_APPROVE_ARM_MS);
      return {
        kind: "approval",
        key: request.key,
        id: approval.id,
        names,
        title: approval.title,
        message: approval.message,
        detail: [`The agent on ${approvalVm(approval)}`, timeLeft]
          .filter((part) => part !== "")
          .join(" · "),
        approveLabel: approval.action !== "" ? approval.action : "Approve",
        denyLabel: approval.deny !== "" ? approval.deny : "Deny",
        armed,
      };
    });
  const listed = waiting.length > 1;
  const title =
    waiting.length === 0
      ? "Key vault"
      : listed
        ? `Key vault: ${waiting.length} requests waiting for your approval`
        : `Key vault: ${items[0]!.names} waiting for your approval`;
  const hidden = waiting.length - items.length;
  const more = hidden > 0 ? `and ${hidden} more` : null;
  const companionHint = items.some((item) => item.kind === "note" && item.approveUrl === null)
    ? VAULT_COMPANION_HINT
    : null;
  const result = resultLine?.text ?? null;
  return {
    title,
    items,
    listed,
    more,
    companionHint,
    result,
    busy,
    keys: waiting.map((request) => request.key),
    nextChangeAt,
    signature: JSON.stringify([title, items, more, companionHint, result, busy]),
  };
}

/** The end of a note's hold, or null: no Companion to wait for, or no first-seen time. */
function vaultNoteHoldEnd(
  companion: ConstructVaultCompanionView | null,
  key: string,
): number | null {
  if (companion === null || !companion.available) return null;
  const since = companion.notesFirstSeen.get(key);
  return since === undefined ? null : since + VAULT_NOTE_HOLD_MS;
}

/** Every request that waits, unsorted: the Companion's approvals and the VM notes that are
 *  not one of them, except the notes held back for the Companion (and when the first of
 *  those shows anyway). */
function collectVaultWaiting(
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
  companion: ConstructVaultCompanionView | null,
): { readonly waiting: WaitingEntry[]; readonly heldUntil: number | null } {
  const waiting: WaitingEntry[] = [];
  let heldUntil: number | null = null;
  const claiming: ConstructVaultApproval[] = [];
  if (companion !== null) {
    const listed = new Set<string>();
    for (const approval of companion.approvals) {
      listed.add(approval.id);
      claiming.push(approval);
      if (companion.decided.has(approval.id)) continue;
      const left = approval.deadline === null ? Infinity : approval.deadline - clientNow;
      if (left <= 0) continue;
      waiting.push({
        kind: "approval",
        key: constructVaultApprovalKey(approval.id),
        left,
        names: approval.names,
        approval,
      });
    }
    for (const { approval, lastSeen } of companion.recent.values()) {
      if (!listed.has(approval.id) && clientNow - lastSeen < VAULT_MATCH_GRACE_MS) {
        claiming.push(approval);
      }
    }
  }
  const seen = new Set<string>();
  for (const reading of readings) {
    const serverNow = reading.pending.now + Math.max(0, clientNow - reading.receivedAt);
    for (const note of reading.pending.notes) {
      const key = constructVaultPendingKey(note.vm, note.id);
      const left = note.deadline - serverNow;
      if (left <= 0 || seen.has(key)) continue;
      seen.add(key);
      if (claiming.some((approval) => vaultNoteMatchesApproval(note, approval))) continue;
      const holdEnd = vaultNoteHoldEnd(companion, key);
      if (holdEnd !== null && clientNow < holdEnd) {
        heldUntil = heldUntil === null ? holdEnd : Math.min(heldUntil, holdEnd);
        continue;
      }
      waiting.push({
        kind: "note",
        key,
        left,
        vm: note.vm === "" ? reading.environmentLabel : note.vm,
        names: note.names,
        reason: note.reason,
        approveUrl: note.approveUrl,
      });
    }
  }
  return { waiting, heldUntil };
}

/** Requests wait, and the user closed the banner on every one of them. */
function everyVaultRequestHidden(
  waiting: ReadonlyArray<WaitingEntry>,
  hiddenKeys: ReadonlySet<string>,
): boolean {
  return waiting.length > 0 && waiting.every((request) => hiddenKeys.has(request.key));
}

/**
 * The user closed the banner on every request that waits: it stays away until another
 * request waits (`buildConstructVaultBanner` is null), and it tells the Companion nothing.
 */
export function isVaultBannerHiddenByUser(
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
  hiddenKeys: ReadonlySet<string>,
  companion: ConstructVaultCompanionView | null = null,
): boolean {
  const { waiting } = collectVaultWaiting(readings, clientNow, companion);
  return everyVaultRequestHidden(waiting, hiddenKeys);
}

/**
 * When the first VM note held back for the Companion shows anyway (client clock), or null
 * when none is held: the banner renders again then, and asks the Companion faster meanwhile.
 */
export function vaultNotesHeldUntil(
  readings: Iterable<ConstructVaultPendingReading>,
  clientNow: number,
  companion: ConstructVaultCompanionView | null = null,
): number | null {
  return collectVaultWaiting(readings, clientNow, companion).heldUntil;
}

/** How long the Desktop app waits before it asks the Companion again. */
export function vaultCompanionPollDelay(heldUntil: number | null): number {
  return heldUntil === null ? VAULT_POLL_INTERVAL_MS : VAULT_HOLD_POLL_INTERVAL_MS;
}

/**
 * What the Desktop app reports to the Construct Companion after each successful answer
 * from it: the ids of the Companion approvals the banner shows inline, possibly none (the
 * app is visible and shows none). Null reports nothing: the page is hidden, or the user
 * closed the banner on the requests that wait. Without reports the Companion's marks
 * expire and its own pop-out takes over.
 */
export function vaultDisplayedReport(
  visibility: DocumentVisibilityState,
  banner: ConstructVaultBanner | null,
  hiddenByUser: boolean,
): ReadonlyArray<string> | null {
  if (visibility !== "visible" || hiddenByUser) return null;
  if (banner === null) return [];
  return banner.items.flatMap((item) => (item.kind === "approval" ? [item.id] : []));
}
