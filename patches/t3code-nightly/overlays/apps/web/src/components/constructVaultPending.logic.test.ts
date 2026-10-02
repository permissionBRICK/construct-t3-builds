import type { ConstructVaultPendingNote } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConstructVaultBanner,
  constructVaultPendingKey,
  type ConstructVaultPendingReading,
  formatVaultNames,
  formatVaultTimeLeft,
  VAULT_COMPANION_HINT,
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
    expect(banner?.items[0]?.approveUrl).toBeNull();
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
