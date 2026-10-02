import { describe, expect, it } from "@effect/vitest";

import {
  clipVaultText,
  parseVaultPendingNote,
  sortVaultPendingNotes,
  vaultApproveUrl,
  vaultPendingFileId,
} from "./constructVaultPending.logic.ts";

const NOW = 1_800_000_000_000;
const ID = "1800000000000-4242-0a1b2c3d";

const note = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: ID,
  vm: "agent-vm",
  op: "request",
  names: ["github-token"],
  reason: "publish the release",
  deadline: NOW + 120_000,
  approveUrl: `https://host.example:7462/vault/#request=${ID}`,
  ...over,
});
const parse = (over: Record<string, unknown> = {}) =>
  parseVaultPendingNote(JSON.stringify(note(over)), ID, NOW);

describe("vaultPendingFileId", () => {
  it("takes the id from <id>.json and nothing else", () => {
    expect(vaultPendingFileId(`${ID}.json`)).toBe(ID);
    expect(vaultPendingFileId(`.tmp.${ID}`)).toBeNull();
    expect(vaultPendingFileId(".hidden.json")).toBeNull();
    expect(vaultPendingFileId(`${ID}.json.tmp`)).toBeNull();
    expect(vaultPendingFileId(`${ID}.txt`)).toBeNull();
    expect(vaultPendingFileId(".json")).toBeNull();
    expect(vaultPendingFileId("a b.json")).toBeNull();
  });
});

describe("parseVaultPendingNote", () => {
  it("accepts a note that follows the contract", () => {
    expect(parse()).toEqual({
      id: ID,
      vm: "agent-vm",
      op: "request",
      names: ["github-token"],
      reason: "publish the release",
      deadline: NOW + 120_000,
      approveUrl: `https://host.example:7462/vault/#request=${ID}`,
    });
    expect(parse({ approveUrl: null })?.approveUrl).toBeNull();
    expect(parse({ reason: "" })?.reason).toBe("");
    expect(parse({ op: "delete", names: ["a", "b.c_d-e"] })?.names).toEqual(["a", "b.c_d-e"]);
  });

  it("ignores text that is not a note object", () => {
    expect(parseVaultPendingNote("{", ID, NOW)).toBeNull();
    expect(parseVaultPendingNote("[]", ID, NOW)).toBeNull();
    expect(parseVaultPendingNote("null", ID, NOW)).toBeNull();
    expect(parseVaultPendingNote('"note"', ID, NOW)).toBeNull();
  });

  it("ignores another version, an unknown op or an id its file name does not carry", () => {
    expect(parse({ v: 2 })).toBeNull();
    expect(parse({ v: "1" })).toBeNull();
    expect(parse({ op: "release" })).toBeNull();
    expect(parse({ op: 1 })).toBeNull();
    expect(parse({ id: "someone-else" })).toBeNull();
    expect(parse({ id: undefined })).toBeNull();
    expect(parse({ vm: 7 })).toBeNull();
  });

  it("ignores names outside the secret-name pattern, none, or more than 20", () => {
    expect(parse({ names: [] })).toBeNull();
    expect(parse({ names: "github-token" })).toBeNull();
    expect(parse({ names: ["-leading-dash"] })).toBeNull();
    expect(parse({ names: ["has space"] })).toBeNull();
    expect(parse({ names: ["<script>"] })).toBeNull();
    expect(parse({ names: ["a".repeat(65)] })).toBeNull();
    expect(parse({ names: [42] })).toBeNull();
    expect(parse({ names: ["ok", "../etc/passwd"] })).toBeNull();
    expect(parse({ names: Array.from({ length: 21 }, (_, i) => `n${i}`) })).toBeNull();
    expect(parse({ names: Array.from({ length: 20 }, (_, i) => `n${i}`) })?.names).toHaveLength(20);
  });

  it("ignores a deadline that is not a number or already passed", () => {
    expect(parse({ deadline: String(NOW + 60_000) })).toBeNull();
    expect(parse({ deadline: null })).toBeNull();
    expect(parse({ deadline: NOW })).toBeNull();
    expect(parse({ deadline: NOW - 1 })).toBeNull();
    expect(
      parseVaultPendingNote(
        JSON.stringify(note()).replace(/"deadline":\d+/, '"deadline":1e999'),
        ID,
        NOW,
      ),
    ).toBeNull();
  });

  it("drops an approveUrl that is not an absolute http(s) URL", () => {
    expect(parse({ approveUrl: "javascript:alert(1)" })?.approveUrl).toBeNull();
    expect(parse({ approveUrl: "/vault/#request=x" })?.approveUrl).toBeNull();
    expect(parse({ approveUrl: "file:///etc/passwd" })?.approveUrl).toBeNull();
    expect(parse({ approveUrl: 7 })?.approveUrl).toBeNull();
    expect(parse({ approveUrl: undefined })?.approveUrl).toBeNull();
  });

  it("clips reason and vm, and treats a missing reason as none", () => {
    const parsed = parse({ reason: "r".repeat(300), vm: "v".repeat(300) });
    expect(parsed?.reason).toHaveLength(100);
    expect(parsed?.vm).toHaveLength(100);
    expect(parse({ reason: undefined })?.reason).toBe("");
    expect(parse({ reason: { text: "x" } })?.reason).toBe("");
  });
});

describe("clipVaultText", () => {
  it("flattens control characters and whitespace", () => {
    expect(clipVaultText("  a\nb\t\u0007c\u009b  ")).toBe("a b c");
    expect(clipVaultText(undefined)).toBe("");
  });

  it("never splits a character in two", () => {
    const clipped = clipVaultText("🔑".repeat(150));
    expect(Array.from(clipped)).toHaveLength(100);
    expect(clipped).toBe("🔑".repeat(100));
  });
});

describe("vaultApproveUrl", () => {
  it("keeps absolute http and https URLs only", () => {
    expect(vaultApproveUrl("http://vm.example:7462/vault/#request=a")).toBe(
      "http://vm.example:7462/vault/#request=a",
    );
    expect(vaultApproveUrl("HTTPS://Host.Example/vault/")).toBe("https://host.example/vault/");
    expect(vaultApproveUrl("data:text/html,hi")).toBeNull();
    expect(vaultApproveUrl("host.example/vault")).toBeNull();
    expect(vaultApproveUrl("")).toBeNull();
    expect(vaultApproveUrl(null)).toBeNull();
  });
});

describe("sortVaultPendingNotes", () => {
  it("puts the soonest deadline first and breaks ties by id", () => {
    const base = parse()!;
    const sorted = sortVaultPendingNotes([
      { ...base, id: "c", deadline: NOW + 3 },
      { ...base, id: "b", deadline: NOW + 1 },
      { ...base, id: "a", deadline: NOW + 3 },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });
});
