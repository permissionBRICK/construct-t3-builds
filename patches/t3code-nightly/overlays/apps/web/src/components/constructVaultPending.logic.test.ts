import type { ConstructVaultApproval, ConstructVaultPendingNote } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConstructVaultBanner,
  type ConstructVaultBannerApprovalItem,
  constructVaultApprovalKey,
  type ConstructVaultCompanionView,
  constructVaultPendingKey,
  type ConstructVaultPendingReading,
  formatVaultNames,
  formatVaultTimeLeft,
  isVaultApproveArmed,
  isVaultBannerHiddenByUser,
  rememberVaultApprovals,
  rememberVaultNotesSeen,
  settleVaultDecided,
  VAULT_APPROVE_ARM_MS,
  VAULT_COMPANION_HINT,
  VAULT_HOLD_POLL_INTERVAL_MS,
  VAULT_MATCH_GRACE_MS,
  VAULT_NOTE_HOLD_MS,
  VAULT_POLL_INTERVAL_MS,
  VAULT_RESULT_VISIBLE_MS,
  vaultApproveUrlRequest,
  vaultCompanionPollDelay,
  vaultDecisionResultText,
  vaultDecisionSettles,
  vaultDisplayedReport,
  vaultNoteMatchesApproval,
  vaultNotesHeldUntil,
} from "./constructVaultPending.logic";

const SERVER_NOW = 1_800_000_000_000;
const CLIENT_NOW = 1_700_000_000_000; // a client clock far off the VM's
const MIN = 60_000;

const note = (
  id: string,
  over: Partial<ConstructVaultPendingNote> = {},
): ConstructVaultPendingNote => ({
  id,
  vm: "agent-vm",
  op: "request",
  names: ["github-token"],
  reason: "publish the release",
  deadline: SERVER_NOW + 5 * MIN,
  approveUrl: `https://host.example:7462/vault/#request=${id}`,
  ...over,
});
const reading = (
  notes: ConstructVaultPendingNote[],
  over: Partial<ConstructVaultPendingReading> = {},
): ConstructVaultPendingReading => ({
  environmentLabel: "Agent VM",
  pending: { now: SERVER_NOW, notes },
  receivedAt: CLIENT_NOW,
  ...over,
});
const none = new Set<string>();

describe("formatVaultTimeLeft", () => {
  it("counts seconds in the last minute, then minutes, hours and days", () => {
    expect(formatVaultTimeLeft(0)).toBe("0 s left");
    expect(formatVaultTimeLeft(400)).toBe("1 s left");
    expect(formatVaultTimeLeft(59_000)).toBe("59 s left");
    expect(formatVaultTimeLeft(60_000)).toBe("1 min left");
    expect(formatVaultTimeLeft(4 * MIN + 59_000)).toBe("4 min left");
    expect(formatVaultTimeLeft(60 * MIN)).toBe("1 h left");
    expect(formatVaultTimeLeft(125 * MIN)).toBe("2 h 5 min left");
    expect(formatVaultTimeLeft(50 * 60 * MIN)).toBe("2 d left");
  });
});

describe("formatVaultNames", () => {
  it("spells out up to three names", () => {
    expect(formatVaultNames(["a"])).toBe("a");
    expect(formatVaultNames(["a", "b", "c"])).toBe("a, b, c");
    expect(formatVaultNames(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});

describe("buildConstructVaultBanner", () => {
  it("is absent while nothing waits", () => {
    expect(buildConstructVaultBanner([], CLIENT_NOW, none)).toBeNull();
    expect(buildConstructVaultBanner([reading([])], CLIENT_NOW, none)).toBeNull();
  });

  it("names one request's secrets in the title and links its approval page", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("a", { names: ["github-token", "npm-token"] })])],
      CLIENT_NOW,
      none,
    );
    expect(banner?.title).toBe("Key vault: github-token, npm-token waiting for your approval");
    expect(banner?.listed).toBe(false);
    expect(banner?.items).toEqual([
      {
        kind: "note",
        key: constructVaultPendingKey("agent-vm", "a"),
        names: "github-token, npm-token",
        detail: "The agent on agent-vm · publish the release · 5 min left",
        approveUrl: "https://host.example:7462/vault/#request=a",
      },
    ]);
    expect(banner?.companionHint).toBeNull();
    expect(banner?.more).toBeNull();
  });

  it("sends the user to the Companion when there is no approval link", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("a", { approveUrl: null, reason: "" })])],
      CLIENT_NOW,
      none,
    );
    expect(banner?.items[0]).toMatchObject({ kind: "note", approveUrl: null });
    expect(banner?.items[0]?.detail).toBe("The agent on agent-vm · 5 min left");
    expect(banner?.companionHint).toBe(VAULT_COMPANION_HINT);
  });

  it("falls back to the environment's label for a note without a VM name", () => {
    const banner = buildConstructVaultBanner([reading([note("a", { vm: "" })])], CLIENT_NOW, none);
    expect(banner?.items[0]?.detail).toContain("The agent on Agent VM");
  });

  it("counts down on the server's clock, not the client's", () => {
    const later = CLIENT_NOW + 2 * MIN + 30_000;
    const banner = buildConstructVaultBanner([reading([note("a")])], later, none);
    expect(banner?.items[0]?.detail).toContain("2 min left");
    // Past the deadline by the server's clock: gone, whatever the client's clock says.
    expect(
      buildConstructVaultBanner([reading([note("a")])], CLIENT_NOW + 5 * MIN, none),
    ).toBeNull();
    // A client clock that went backwards never adds time.
    const backwards = buildConstructVaultBanner(
      [reading([note("a")])],
      CLIENT_NOW - 10 * MIN,
      none,
    );
    expect(backwards?.items[0]?.detail).toContain("5 min left");
  });

  it("lists several requests, most urgent first, three at most", () => {
    const banner = buildConstructVaultBanner(
      [
        reading([
          note("late", { deadline: SERVER_NOW + 9 * MIN }),
          note("soon", { deadline: SERVER_NOW + MIN, names: ["npm-token"] }),
          note("mid", { deadline: SERVER_NOW + 3 * MIN, approveUrl: null }),
        ]),
        reading([note("other", { vm: "other-vm", deadline: SERVER_NOW + 2 * MIN })]),
        reading([note("last", { vm: "other-vm", deadline: SERVER_NOW + 10 * MIN })]),
      ],
      CLIENT_NOW,
      none,
    );
    expect(banner?.title).toBe("Key vault: 5 requests waiting for your approval");
    expect(banner?.listed).toBe(true);
    expect(banner?.items.map((item) => item.names)).toEqual([
      "npm-token",
      "github-token",
      "github-token",
    ]);
    expect(banner?.items.map((item) => item.detail)).toEqual([
      "The agent on agent-vm · publish the release · 1 min left",
      "The agent on other-vm · publish the release · 2 min left",
      "The agent on agent-vm · publish the release · 3 min left",
    ]);
    expect(banner?.more).toBe("and 2 more");
    expect(banner?.companionHint).toBe(VAULT_COMPANION_HINT);
    expect(banner?.keys).toHaveLength(5);
  });

  it("shows a request reported by two connections to the same VM once", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("a")]), reading([note("a")])],
      CLIENT_NOW,
      none,
    );
    expect(banner?.listed).toBe(false);
    expect(banner?.keys).toEqual([constructVaultPendingKey("agent-vm", "a")]);
  });

  it("stays hidden until a request outside the hidden set waits", () => {
    const first = buildConstructVaultBanner([reading([note("a"), note("b")])], CLIENT_NOW, none);
    const hidden = new Set(first?.keys);
    expect(
      buildConstructVaultBanner([reading([note("a"), note("b")])], CLIENT_NOW, hidden),
    ).toBeNull();
    expect(buildConstructVaultBanner([reading([note("b")])], CLIENT_NOW, hidden)).toBeNull();
    const again = buildConstructVaultBanner([reading([note("a"), note("c")])], CLIENT_NOW, hidden);
    expect(again?.title).toBe("Key vault: 2 requests waiting for your approval");
  });

  it("changes its signature only when what it shows changes", () => {
    const at = (clientNow: number) =>
      buildConstructVaultBanner([reading([note("a")])], clientNow, none)?.signature;
    expect(at(CLIENT_NOW + 1_000)).toBe(at(CLIENT_NOW + 3_000));
    expect(at(CLIENT_NOW + 1_000)).not.toBe(at(CLIENT_NOW + MIN + 1_000));
  });
});

// ── The Construct Companion on this PC (Desktop app) ────────────────────────────

const approval = (
  id: string,
  over: Partial<ConstructVaultApproval> = {},
): ConstructVaultApproval => ({
  id,
  instance: "agent-vm",
  vm: "agent-vm",
  kind: "local",
  host: null,
  requestId: null,
  hostRequestId: null,
  op: "request",
  title: "Key vault request from agent-vm",
  message: "The agent asks for github-token.\nReason: publish the release",
  action: "Approve",
  deny: "Deny",
  names: ["github-token"],
  createdAt: CLIENT_NOW - MIN,
  deadline: CLIENT_NOW + 4 * MIN,
  ...over,
});
const companion = (
  approvals: ConstructVaultApproval[],
  over: Partial<ConstructVaultCompanionView> = {},
): ConstructVaultCompanionView => ({
  approvals,
  recent: rememberVaultApprovals(new Map(), approvals, CLIENT_NOW),
  decided: new Set(),
  shownSince: new Map(approvals.map((item) => [item.id, CLIENT_NOW - VAULT_APPROVE_ARM_MS])),
  busy: false,
  result: null,
  available: true,
  notesFirstSeen: new Map(),
  ...over,
});
const approvalItems = (banner: ReturnType<typeof buildConstructVaultBanner>) =>
  (banner?.items ?? []).filter(
    (item): item is ConstructVaultBannerApprovalItem => item.kind === "approval",
  );

describe("matching VM notes to Companion approvals", () => {
  it("reads the request id from the approval link's fragment", () => {
    expect(vaultApproveUrlRequest("https://host.example:7462/vault/#request=h-1")).toBe("h-1");
    expect(vaultApproveUrlRequest("https://host.example/vault/#x=1&request=h%2D2")).toBe("h-2");
    expect(vaultApproveUrlRequest("https://host.example/vault/?request=h-1")).toBeNull();
    expect(vaultApproveUrlRequest("https://host.example/vault/#request=")).toBeNull();
    expect(vaultApproveUrlRequest(null)).toBeNull();
  });

  it("matches a local VM's note by its id and a hosted VM's note by its link", () => {
    const local = approval("c1", { requestId: "a" });
    const hosted = approval("c2", { kind: "host", host: "host", hostRequestId: "h-9" });
    expect(vaultNoteMatchesApproval(note("a", { approveUrl: null }), local)).toBe(true);
    expect(vaultNoteMatchesApproval(note("b", { approveUrl: null }), local)).toBe(false);
    expect(
      vaultNoteMatchesApproval(
        note("x", { approveUrl: "https://host.example/vault/#request=h-9" }),
        hosted,
      ),
    ).toBe(true);
    // The note's own id is not the host's approval id, and null ids never match.
    expect(vaultNoteMatchesApproval(note("h-9", { approveUrl: null }), hosted)).toBe(false);
    expect(vaultNoteMatchesApproval(note("a"), approval("c3"))).toBe(false);
  });
});

describe("buildConstructVaultBanner with the Companion", () => {
  it("lists a Companion approval inline with its own texts and both buttons", () => {
    const banner = buildConstructVaultBanner(
      [],
      CLIENT_NOW,
      none,
      companion([approval("c1", { names: ["github-token", "npm-token"] })]),
    );
    expect(banner?.title).toBe("Key vault: github-token, npm-token waiting for your approval");
    expect(banner?.items).toEqual([
      {
        kind: "approval",
        key: constructVaultApprovalKey("c1"),
        id: "c1",
        names: "github-token, npm-token",
        title: "Key vault request from agent-vm",
        message: "The agent asks for github-token.\nReason: publish the release",
        detail: "The agent on agent-vm · 4 min left",
        approveLabel: "Approve",
        denyLabel: "Deny",
        armed: true,
      },
    ]);
    expect(banner?.companionHint).toBeNull();
    expect(banner?.result).toBeNull();
    expect(banner?.keys).toEqual([constructVaultApprovalKey("c1")]);
  });

  it("shows a VM note that is a Companion approval once, as the approval", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("a", { approveUrl: null }), note("b"), note("other", { vm: "other-vm" })])],
      CLIENT_NOW,
      none,
      companion([
        approval("c1", { requestId: "a" }),
        approval("c2", { kind: "host", host: "host", hostRequestId: "b" }),
      ]),
    );
    expect(banner?.title).toBe("Key vault: 3 requests waiting for your approval");
    expect(banner?.items.map((item) => item.kind)).toEqual(["approval", "approval", "note"]);
    expect(banner?.keys).toEqual([
      constructVaultApprovalKey("c1"),
      constructVaultApprovalKey("c2"),
      constructVaultPendingKey("other-vm", "other"),
    ]);
    // The unmatched note keeps its link, so no Companion hint.
    expect(banner?.companionHint).toBeNull();
  });

  it("keeps the Companion hint for an unmatched note without a link", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("a", { approveUrl: null })])],
      CLIENT_NOW,
      none,
      companion([approval("c1", { requestId: "elsewhere" })]),
    );
    expect(banner?.items.map((item) => item.kind)).toEqual(["approval", "note"]);
    expect(banner?.companionHint).toBe(VAULT_COMPANION_HINT);
  });

  it("orders approvals and notes together, most urgent first; no deadline goes last", () => {
    const banner = buildConstructVaultBanner(
      [reading([note("n", { deadline: SERVER_NOW + 2 * MIN })])],
      CLIENT_NOW,
      none,
      companion([
        approval("never", { deadline: null, createdAt: CLIENT_NOW - 5 * MIN }),
        approval("soon", { deadline: CLIENT_NOW + MIN }),
        approval("gone", { deadline: CLIENT_NOW - 1 }),
      ]),
    );
    expect(banner?.keys).toEqual([
      constructVaultApprovalKey("soon"),
      constructVaultPendingKey("agent-vm", "n"),
      constructVaultApprovalKey("never"),
    ]);
    expect(approvalItems(banner).at(-1)?.detail).toBe("The agent on agent-vm");
  });

  it("names the instance when the Companion has no VM name, and falls back on button texts", () => {
    const [item] = approvalItems(
      buildConstructVaultBanner(
        [],
        CLIENT_NOW,
        none,
        companion([approval("c1", { vm: "", instance: "work-vm", action: "", deny: "" })]),
      ),
    );
    expect(item?.detail).toBe("The agent on work-vm · 4 min left");
    expect([item?.approveLabel, item?.denyLabel]).toEqual(["Approve", "Deny"]);
  });

  it("drops an approval answered elsewhere on the next Companion answer", () => {
    // Answered in the Companion's dialog, on the phone or by its deadline: the next list
    // simply lacks it, and the banner shows only what is listed.
    const first = companion([approval("c1", { requestId: "a" }), approval("c2")]);
    expect(
      buildConstructVaultBanner([reading([note("a")])], CLIENT_NOW, none, first)?.keys,
    ).toHaveLength(2);
    const later = CLIENT_NOW + 3_000;
    const next = companion([approval("c2")], {
      recent: rememberVaultApprovals(first.recent, [approval("c2")], later),
    });
    const banner = buildConstructVaultBanner([reading([note("a")])], later, none, next);
    expect(banner?.keys).toEqual([constructVaultApprovalKey("c2")]);
    // Its VM note, which the CLI removes a moment later, does not come back meanwhile.
    expect(banner?.items.some((item) => item.kind === "note")).toBe(false);
    // Nothing listed and no note: no banner at all.
    expect(
      buildConstructVaultBanner([], later, none, companion([], { recent: next.recent })),
    ).toBeNull();
  });

  it("lets a VM note show again once its approval left the list for good", () => {
    const recent = rememberVaultApprovals(
      new Map(),
      [approval("c1", { requestId: "a" })],
      CLIENT_NOW,
    );
    const within = CLIENT_NOW + VAULT_MATCH_GRACE_MS - 1;
    const after = CLIENT_NOW + VAULT_MATCH_GRACE_MS;
    expect(
      buildConstructVaultBanner([reading([note("a")])], within, none, companion([], { recent })),
    ).toBeNull();
    const banner = buildConstructVaultBanner(
      [reading([note("a")])],
      after,
      none,
      companion([], { recent: rememberVaultApprovals(recent, [], after) }),
    );
    expect(banner?.items.map((item) => item.kind)).toEqual(["note"]);
  });

  it("hides an approval decided here at once, while the Companion still lists it", () => {
    const approvals = [approval("c1", { requestId: "a" }), approval("c2")];
    const decided = new Set(["c1"]);
    const pending = {
      text: vaultDecisionResultText(approvals[0]!, "approve", "pending"),
      at: CLIENT_NOW,
      pending: true,
    };
    const banner = buildConstructVaultBanner(
      [reading([note("a")])],
      CLIENT_NOW,
      none,
      companion(approvals, { decided, busy: true, result: pending }),
    );
    expect(banner?.keys).toEqual([constructVaultApprovalKey("c2")]);
    expect(banner?.result).toBe("Approving github-token for agent-vm…");
    expect(banner?.busy).toBe(true);
    // The pending line never times out.
    expect(
      buildConstructVaultBanner(
        [],
        CLIENT_NOW + 60_000,
        none,
        companion(approvals, { decided, busy: true, result: pending }),
      )?.result,
    ).toBe("Approving github-token for agent-vm…");
  });

  it("keeps the result line after the last request was decided, then goes away", () => {
    const decided = approval("c1");
    const result = {
      text: vaultDecisionResultText(decided, "approve", { ok: true }),
      at: CLIENT_NOW,
      pending: false,
    };
    const banner = buildConstructVaultBanner(
      [],
      CLIENT_NOW + 1_000,
      none,
      companion([decided], { decided: new Set(["c1"]), result }),
    );
    expect(banner?.title).toBe("Key vault");
    expect(banner?.items).toEqual([]);
    expect(banner?.result).toBe("Approved github-token for agent-vm.");
    expect(banner?.nextChangeAt).toBe(CLIENT_NOW + VAULT_RESULT_VISIBLE_MS);
    expect(
      buildConstructVaultBanner(
        [],
        CLIENT_NOW + VAULT_RESULT_VISIBLE_MS,
        none,
        companion([], { result }),
      ),
    ).toBeNull();
  });

  it("arms Approve a second after the approval shows", () => {
    const view = companion([approval("c1"), approval("c2")], {
      shownSince: new Map([["c1", CLIENT_NOW - 400]]),
    });
    const banner = buildConstructVaultBanner([], CLIENT_NOW, none, view);
    expect(approvalItems(banner).map((item) => item.armed)).toEqual([false, false]);
    // c1 arms first; c2 has not shown yet, so it arms a full second from now.
    expect(banner?.nextChangeAt).toBe(CLIENT_NOW - 400 + VAULT_APPROVE_ARM_MS);
    const later = buildConstructVaultBanner([], CLIENT_NOW + 600, none, view);
    expect(approvalItems(later).map((item) => item.armed)).toEqual([true, false]);
    expect(isVaultApproveArmed(undefined, CLIENT_NOW)).toBe(false);
    expect(isVaultApproveArmed(CLIENT_NOW, CLIENT_NOW + VAULT_APPROVE_ARM_MS - 1)).toBe(false);
    expect(isVaultApproveArmed(CLIENT_NOW, CLIENT_NOW + VAULT_APPROVE_ARM_MS)).toBe(true);
  });

  it("changes its signature with arming, sending and results", () => {
    const view = companion([approval("c1")], { shownSince: new Map([["c1", CLIENT_NOW]]) });
    const unarmed = buildConstructVaultBanner([], CLIENT_NOW, none, view)?.signature;
    const armed = buildConstructVaultBanner([], CLIENT_NOW + 1_000, none, view)?.signature;
    const busy = buildConstructVaultBanner([], CLIENT_NOW + 1_000, none, {
      ...view,
      busy: true,
    })?.signature;
    expect(new Set([unarmed, armed, busy]).size).toBe(3);
  });

  it("stays hidden for hidden approvals until another request waits", () => {
    const view = companion([approval("c1")]);
    const first = buildConstructVaultBanner([], CLIENT_NOW, none, view);
    const hidden = new Set(first?.keys);
    expect(buildConstructVaultBanner([], CLIENT_NOW, hidden, view)).toBeNull();
    expect(
      buildConstructVaultBanner([], CLIENT_NOW, hidden, companion([approval("c1"), approval("c2")]))
        ?.title,
    ).toBe("Key vault: 2 requests waiting for your approval");
  });

  it("lists notes exactly as before without the Companion", () => {
    const readings = [reading([note("a", { approveUrl: null }), note("b")])];
    const without = buildConstructVaultBanner(readings, CLIENT_NOW, none);
    expect(buildConstructVaultBanner(readings, CLIENT_NOW, none, null)).toEqual(without);
    expect(without?.items.every((item) => item.kind === "note")).toBe(true);
    expect(without?.result).toBeNull();
    expect(without?.nextChangeAt).toBeNull();
  });
});

describe("decisions", () => {
  const item = approval("c1", { names: ["github-token", "npm-token"] });

  it("says what happened", () => {
    expect(vaultDecisionResultText(item, "deny", "pending")).toBe(
      "Denying github-token, npm-token for agent-vm…",
    );
    expect(vaultDecisionResultText(item, "deny", { ok: true })).toBe(
      "Denied github-token, npm-token for agent-vm.",
    );
    expect(vaultDecisionResultText(item, "approve", { ok: false, reason: "already-decided" })).toBe(
      "github-token, npm-token for agent-vm was already answered elsewhere.",
    );
    expect(vaultDecisionResultText(item, "approve", { ok: false, reason: "not-found" })).toBe(
      "github-token, npm-token for agent-vm is no longer waiting.",
    );
    expect(vaultDecisionResultText(item, "approve", { ok: false, reason: "host-failed" })).toBe(
      "The host could not be reached for github-token, npm-token for agent-vm. Try again, or answer in the Companion.",
    );
    expect(vaultDecisionResultText(item, "approve", { ok: false, reason: "unavailable" })).toBe(
      "The Construct Companion is not reachable. github-token, npm-token for agent-vm still waits.",
    );
    expect(vaultDecisionResultText(item, "approve", { ok: false, reason: "error" })).toContain(
      "Try again, or answer in the Companion.",
    );
  });

  it("keeps a settled decision's item hidden and brings a failed one back", () => {
    expect(vaultDecisionSettles({ ok: true })).toBe(true);
    expect(vaultDecisionSettles({ ok: false, reason: "already-decided" })).toBe(true);
    expect(vaultDecisionSettles({ ok: false, reason: "not-found" })).toBe(true);
    expect(vaultDecisionSettles({ ok: false, reason: "host-failed" })).toBe(false);
    expect(vaultDecisionSettles({ ok: false, reason: "unavailable" })).toBe(false);
    expect(vaultDecisionSettles({ ok: false, reason: "error" })).toBe(false);
  });

  it("forgets decided approvals the Companion no longer lists", () => {
    expect([
      ...settleVaultDecided(new Set(["c1", "c2"]), [approval("c2"), approval("c3")]),
    ]).toEqual(["c2"]);
  });

  it("remembers listed approvals for the grace period only", () => {
    const first = rememberVaultApprovals(new Map(), [approval("c1"), approval("c2")], CLIENT_NOW);
    const later = rememberVaultApprovals(
      first,
      [approval("c2")],
      CLIENT_NOW + VAULT_MATCH_GRACE_MS,
    );
    expect([...later.keys()]).toEqual(["c2"]);
    expect(later.get("c2")?.lastSeen).toBe(CLIENT_NOW + VAULT_MATCH_GRACE_MS);
  });
});

describe("reporting what the banner shows to the Companion", () => {
  /** The report after an answer, computed the way the banner computes it. */
  const report = (
    visibility: DocumentVisibilityState,
    readings: ConstructVaultPendingReading[],
    hidden: ReadonlySet<string>,
    view: ConstructVaultCompanionView,
  ) =>
    vaultDisplayedReport(
      visibility,
      buildConstructVaultBanner(readings, CLIENT_NOW, hidden, view),
      isVaultBannerHiddenByUser(readings, CLIENT_NOW, hidden, view),
    );

  it("reports the approvals shown inline, most urgent first, and never the VM notes", () => {
    const view = companion([
      approval("c-late", { deadline: CLIENT_NOW + 8 * MIN }),
      approval("c-soon", { deadline: CLIENT_NOW + 2 * MIN }),
    ]);
    expect(report("visible", [reading([note("n", { approveUrl: null })])], none, view)).toEqual([
      "c-soon",
      "c-late",
    ]);
  });

  it("reports only what is rendered: not the requests beyond the first three", () => {
    const view = companion(
      ["c1", "c2", "c3", "c4"].map((id, index) =>
        approval(id, { deadline: CLIENT_NOW + (index + 1) * MIN }),
      ),
    );
    expect(report("visible", [], none, view)).toEqual(["c1", "c2", "c3"]);
    // A more urgent VM note pushes the last approval out of the banner.
    const urgent = reading([note("n", { deadline: SERVER_NOW + 30_000 })]);
    expect(report("visible", [urgent], none, view)).toEqual(["c1", "c2"]);
  });

  it("leaves out an approval decided here, an expired one and one the Companion no longer lists", () => {
    const view = companion(
      [approval("c1"), approval("c2"), approval("gone", { deadline: CLIENT_NOW - 1 })],
      { decided: new Set(["c1"]) },
    );
    expect(report("visible", [], none, view)).toEqual(["c2"]);
    const later = companion([approval("c3")], {
      recent: rememberVaultApprovals(new Map(), [approval("c2"), approval("c3")], CLIENT_NOW),
    });
    expect(report("visible", [], none, later)).toEqual(["c3"]);
  });

  it("reports an empty list while the page is visible and shows none of them", () => {
    expect(report("visible", [], none, companion([]))).toEqual([]);
    expect(report("visible", [reading([note("n")])], none, companion([]))).toEqual([]);
    // Only the result line of the last decision is left.
    const resultOnly = companion([], {
      result: { text: "Approved github-token for agent-vm.", at: CLIENT_NOW, pending: false },
    });
    expect(report("visible", [], none, resultOnly)).toEqual([]);
  });

  it("reports nothing while the page is hidden", () => {
    expect(report("hidden", [], none, companion([approval("c1")]))).toBeNull();
    expect(report("hidden", [], none, companion([]))).toBeNull();
  });

  it("reports nothing while the user keeps the banner closed, and again once another request waits", () => {
    const view = companion([approval("c1")]);
    const hidden = new Set(buildConstructVaultBanner([], CLIENT_NOW, none, view)?.keys);
    expect(isVaultBannerHiddenByUser([], CLIENT_NOW, hidden, view)).toBe(true);
    expect(report("visible", [], hidden, view)).toBeNull();
    // A closed banner over VM notes says nothing either.
    const notes = [reading([note("n")])];
    const hiddenNotes = new Set(buildConstructVaultBanner(notes, CLIENT_NOW, none)?.keys);
    expect(report("visible", notes, hiddenNotes, companion([]))).toBeNull();
    // Another request brings the banner back, with every request that waits.
    expect(report("visible", [], hidden, companion([approval("c1"), approval("c2")]))).toEqual([
      "c1",
      "c2",
    ]);
    // Once the closed requests are gone, the visible page reports again.
    expect(isVaultBannerHiddenByUser([], CLIENT_NOW, hidden, companion([]))).toBe(false);
    expect(report("visible", [], hidden, companion([]))).toEqual([]);
  });
});

describe("holding VM notes back for the Companion (Desktop app)", () => {
  // A hosted VM's note links the host's approval; the Companion lists that approval only
  // after its next host poll.
  const hosted = note("n1", { approveUrl: "https://host.example:7462/vault/#request=h-1" });
  const hostedApproval = approval("c1", { kind: "host", host: "host", hostRequestId: "h-1" });
  const noteKey = constructVaultPendingKey("agent-vm", "n1");
  const seenAt = (at: number) => new Map([[noteKey, at]]);
  const kinds = (banner: ReturnType<typeof buildConstructVaultBanner>) =>
    banner?.items.map((item) => item.kind) ?? [];

  it("holds an unmatched note back for 10 s after it was first seen", () => {
    const view = companion([], { notesFirstSeen: seenAt(CLIENT_NOW) });
    const readings = [reading([hosted])];
    expect(buildConstructVaultBanner(readings, CLIENT_NOW, none, view)).toBeNull();
    expect(
      buildConstructVaultBanner(readings, CLIENT_NOW + VAULT_NOTE_HOLD_MS - 1, none, view),
    ).toBeNull();
    expect(vaultNotesHeldUntil(readings, CLIENT_NOW, view)).toBe(CLIENT_NOW + VAULT_NOTE_HOLD_MS);
    // Neither shown nor counted next to another request.
    const other = companion([approval("c9", { names: ["npm-token"] })], {
      notesFirstSeen: seenAt(CLIENT_NOW),
    });
    const banner = buildConstructVaultBanner(readings, CLIENT_NOW + 3_000, none, other);
    expect(banner?.title).toBe("Key vault: npm-token waiting for your approval");
    expect(banner?.keys).toEqual([constructVaultApprovalKey("c9")]);
    expect(vaultDisplayedReport("visible", banner, false)).toEqual(["c9"]);
  });

  it("shows only the inline item when the approval arrives within the hold", () => {
    const readings = [reading([hosted])];
    const firstSeen = rememberVaultNotesSeen(new Map(), readings, CLIENT_NOW).firstSeen;
    let recent = rememberVaultApprovals(new Map(), [], CLIENT_NOW);
    // The Companion lists nothing for 3 s, asked every second, then the host's approval.
    for (const at of [0, 1_000, 2_000]) {
      const view = companion([], { recent, notesFirstSeen: firstSeen });
      expect(buildConstructVaultBanner(readings, CLIENT_NOW + at, none, view)).toBeNull();
      recent = rememberVaultApprovals(recent, [], CLIENT_NOW + at);
    }
    for (const at of [3_000, 6_000, VAULT_NOTE_HOLD_MS, 2 * VAULT_NOTE_HOLD_MS]) {
      recent = rememberVaultApprovals(recent, [hostedApproval], CLIENT_NOW + at);
      const view = companion([hostedApproval], { recent, notesFirstSeen: firstSeen });
      const banner = buildConstructVaultBanner(readings, CLIENT_NOW + at, none, view);
      expect(kinds(banner)).toEqual(["approval"]);
      expect(banner?.keys).toEqual([constructVaultApprovalKey("c1")]);
      expect(vaultNotesHeldUntil(readings, CLIENT_NOW + at, view)).toBeNull();
    }
  });

  it("shows the unmatched note with its fallback once the hold ends", () => {
    const view = companion([], { notesFirstSeen: seenAt(CLIENT_NOW) });
    const after = CLIENT_NOW + VAULT_NOTE_HOLD_MS;
    const banner = buildConstructVaultBanner([reading([hosted])], after, none, view);
    expect(banner?.items).toEqual([
      expect.objectContaining({
        kind: "note",
        key: noteKey,
        approveUrl: "https://host.example:7462/vault/#request=h-1",
      }),
    ]);
    expect(vaultNotesHeldUntil([reading([hosted])], after, view)).toBeNull();
    // Without a link, the Companion hint.
    const local = buildConstructVaultBanner(
      [reading([note("n1", { approveUrl: null })])],
      after,
      none,
      view,
    );
    expect(local?.companionHint).toBe(VAULT_COMPANION_HINT);
  });

  it("shows notes at once when the Companion is unavailable or there is no bridge", () => {
    const readings = [reading([hosted])];
    const unavailable = companion([], { available: false, notesFirstSeen: seenAt(CLIENT_NOW) });
    expect(kinds(buildConstructVaultBanner(readings, CLIENT_NOW, none, unavailable))).toEqual([
      "note",
    ]);
    expect(vaultNotesHeldUntil(readings, CLIENT_NOW, unavailable)).toBeNull();
    expect(kinds(buildConstructVaultBanner(readings, CLIENT_NOW, none, null))).toEqual(["note"]);
    expect(vaultNotesHeldUntil(readings, CLIENT_NOW, null)).toBeNull();
  });

  it("asks the Companion every second while a note is held, every 3 s otherwise", () => {
    const readings = [reading([hosted])];
    const view = companion([], { notesFirstSeen: seenAt(CLIENT_NOW) });
    const delay = (at: number, over: Partial<ConstructVaultCompanionView> = {}) =>
      vaultCompanionPollDelay(vaultNotesHeldUntil(readings, at, { ...view, ...over }));
    expect(VAULT_HOLD_POLL_INTERVAL_MS).toBeLessThan(VAULT_POLL_INTERVAL_MS);
    expect(delay(CLIENT_NOW)).toBe(VAULT_HOLD_POLL_INTERVAL_MS);
    expect(delay(CLIENT_NOW + VAULT_NOTE_HOLD_MS - 1)).toBe(VAULT_HOLD_POLL_INTERVAL_MS);
    expect(delay(CLIENT_NOW + VAULT_NOTE_HOLD_MS)).toBe(VAULT_POLL_INTERVAL_MS);
    expect(delay(CLIENT_NOW, { available: false })).toBe(VAULT_POLL_INTERVAL_MS);
    expect(
      delay(CLIENT_NOW, {
        approvals: [hostedApproval],
        recent: companion([hostedApproval]).recent,
      }),
    ).toBe(VAULT_POLL_INTERVAL_MS);
    expect(vaultCompanionPollDelay(vaultNotesHeldUntil([], CLIENT_NOW, view))).toBe(
      VAULT_POLL_INTERVAL_MS,
    );
  });

  it("keeps each note's first-seen time across polls and renders", () => {
    const first = rememberVaultNotesSeen(new Map(), [reading([hosted])], CLIENT_NOW);
    expect(first.added).toBe(true);
    expect([...first.firstSeen]).toEqual([[noteKey, CLIENT_NOW]]);
    // Polled again and again (and reported by a second connection): the time stays.
    let firstSeen: ReadonlyMap<string, number> = first.firstSeen;
    for (const at of [3_000, 6_000, 9_000]) {
      const next = rememberVaultNotesSeen(
        firstSeen,
        [reading([hosted]), reading([hosted])],
        CLIENT_NOW + at,
      );
      expect(next.added).toBe(false);
      firstSeen = next.firstSeen;
    }
    expect([...firstSeen]).toEqual([[noteKey, CLIENT_NOW]]);
    // So the hold ends 10 s after the first sighting, however often it rendered since.
    const view = companion([], { notesFirstSeen: firstSeen });
    expect(vaultNotesHeldUntil([reading([hosted])], CLIENT_NOW + 9_000, view)).toBe(
      CLIENT_NOW + VAULT_NOTE_HOLD_MS,
    );
    // A new note is new; a note that is gone is forgotten.
    const later = rememberVaultNotesSeen(firstSeen, [reading([note("n2")])], CLIENT_NOW + 12_000);
    expect(later.added).toBe(true);
    expect([...later.firstSeen]).toEqual([
      [constructVaultPendingKey("agent-vm", "n2"), CLIENT_NOW + 12_000],
    ]);
  });

  it("does not hold a note without a first-seen time, nor a closed banner's requests back", () => {
    // Untracked: shown at once.
    expect(
      kinds(buildConstructVaultBanner([reading([hosted])], CLIENT_NOW, none, companion([]))),
    ).toEqual(["note"]);
    // The user closed the banner on c9; a held note does not bring it back, and nothing
    // is reported meanwhile.
    const view = companion([approval("c9")], { notesFirstSeen: seenAt(CLIENT_NOW) });
    const hidden = new Set([constructVaultApprovalKey("c9")]);
    expect(buildConstructVaultBanner([reading([hosted])], CLIENT_NOW, hidden, view)).toBeNull();
    expect(isVaultBannerHiddenByUser([reading([hosted])], CLIENT_NOW, hidden, view)).toBe(true);
    // Once the hold ends, the note is a request the user has not closed: the banner is back.
    const after = CLIENT_NOW + VAULT_NOTE_HOLD_MS;
    expect(buildConstructVaultBanner([reading([hosted])], after, hidden, view)?.keys).toEqual([
      constructVaultApprovalKey("c9"),
      noteKey,
    ]);
  });
});
