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
  rememberVaultApprovals,
  settleVaultDecided,
  VAULT_APPROVE_ARM_MS,
  VAULT_COMPANION_HINT,
  VAULT_MATCH_GRACE_MS,
  VAULT_RESULT_VISIBLE_MS,
  vaultApproveUrlRequest,
  vaultDecisionResultText,
  vaultDecisionSettles,
  vaultNoteMatchesApproval,
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
