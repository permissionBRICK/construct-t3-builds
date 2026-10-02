// @effect-diagnostics nodeBuiltinImport:off - the reader is tested against a real directory of hostile files.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  constructVaultPendingDir,
  DEFAULT_VAULT_PENDING_DIR,
  readConstructVaultPending,
} from "./constructVaultPending.ts";

const ENV = "CONSTRUCT_VAULT_PENDING_DIR";
/** Far ahead of any clock this test runs under. */
const FUTURE = 4_102_444_800_000;

let root: string;
let dir: string;
let previousEnv: string | undefined;

const note = (id: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  vm: "agent-vm",
  op: "request",
  names: ["github-token"],
  reason: "publish the release",
  deadline: FUTURE,
  approveUrl: `https://host.example:7462/vault/#request=${id}`,
  ...over,
});
const writeAt = (path: string, content: unknown) =>
  NodeFS.writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), {
    mode: 0o644,
  });
const write = (name: string, content: unknown) => writeAt(NodePath.join(dir, name), content);
const snapshot = () =>
  NodeFS.readdirSync(dir)
    .sort()
    .map((name) => {
      const stats = NodeFS.lstatSync(NodePath.join(dir, name));
      return `${name}:${stats.isFile() ? NodeFS.readFileSync(NodePath.join(dir, name), "utf8") : stats.mode}`;
    });

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "construct-vault-pending-"));
  dir = NodePath.join(root, "vault-pending");
  NodeFS.mkdirSync(dir, { mode: 0o755 });
  previousEnv = process.env[ENV];
  process.env[ENV] = dir;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = previousEnv;
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("constructVaultPendingDir", () => {
  it("uses the override when set, else the CLI's directory", () => {
    expect(constructVaultPendingDir({ [ENV]: " /tmp/x " })).toBe("/tmp/x");
    expect(constructVaultPendingDir({ [ENV]: "" })).toBe(DEFAULT_VAULT_PENDING_DIR);
    expect(constructVaultPendingDir({})).toBe("/run/construct/vault-pending");
  });
});

describe("readConstructVaultPending", () => {
  it.effect("reads the notes of the override directory, soonest deadline first", () =>
    Effect.gen(function* () {
      write("b.json", note("b", { deadline: FUTURE - 60_000, approveUrl: null, reason: "" }));
      write("a.json", note("a", { names: ["npm-token", "github-token"], op: "get" }));
      const pending = yield* readConstructVaultPending();
      expect(pending.now).toBeGreaterThan(0);
      expect(pending.notes).toEqual([
        {
          id: "b",
          vm: "agent-vm",
          op: "request",
          names: ["github-token"],
          reason: "",
          deadline: FUTURE - 60_000,
          approveUrl: null,
        },
        {
          id: "a",
          vm: "agent-vm",
          op: "get",
          names: ["npm-token", "github-token"],
          reason: "publish the release",
          deadline: FUTURE,
          approveUrl: "https://host.example:7462/vault/#request=a",
        },
      ]);
    }),
  );

  it.effect("has no notes when the directory is missing, a file or a symlink", () =>
    Effect.gen(function* () {
      write("a.json", note("a"));
      expect((yield* readConstructVaultPending(NodePath.join(root, "missing"))).notes).toEqual([]);
      expect((yield* readConstructVaultPending(NodePath.join(dir, "a.json"))).notes).toEqual([]);
      NodeFS.symlinkSync(dir, NodePath.join(root, "linked"));
      expect((yield* readConstructVaultPending(NodePath.join(root, "linked"))).notes).toEqual([]);
    }),
  );

  it.effect("ignores hostile and broken files without touching any of them", () =>
    Effect.gen(function* () {
      write("good.json", note("good"));
      write(".tmp.temp", note("temp"));
      write(".hidden.json", note(".hidden"));
      write("text.txt", note("text"));
      write("broken.json", "{ not json");
      write("empty.json", "");
      write("v2.json", note("v2", { v: 2 }));
      write("op.json", note("op", { op: "release" }));
      write("names.json", note("names", { names: ["bad name"] }));
      write("many.json", note("many", { names: Array.from({ length: 21 }, (_, i) => `n${i}`) }));
      write("late.json", note("late", { deadline: 1 }));
      write("textdeadline.json", note("textdeadline", { deadline: String(FUTURE) }));
      write("mismatch.json", note("someone-else"));
      write("huge.json", note("huge", { reason: "x".repeat(5000) }));
      write("url.json", note("url", { approveUrl: "javascript:alert(1)", vm: "v".repeat(500) }));
      // A symlink to a valid note outside the directory is never followed.
      const outside = NodePath.join(root, "outside.json");
      writeAt(outside, note("linked"));
      NodeFS.symlinkSync(outside, NodePath.join(dir, "linked.json"));
      NodeFS.symlinkSync("/etc/passwd", NodePath.join(dir, "passwd.json"));
      NodeFS.mkdirSync(NodePath.join(dir, "folder.json"));
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "fifo.json")]);
      const before = snapshot();

      const pending = yield* readConstructVaultPending();
      expect(pending.notes.map((entry) => entry.id)).toEqual(["good", "url"]);
      const url = pending.notes.find((entry) => entry.id === "url");
      expect(url?.approveUrl).toBeNull();
      expect(url?.vm).toHaveLength(100);
      expect(snapshot()).toEqual(before);
    }),
  );

  it.effect("reads at most 50 files", () =>
    Effect.gen(function* () {
      for (let index = 0; index < 60; index++) {
        const id = `n${String(index).padStart(2, "0")}`;
        write(`${id}.json`, note(id));
      }
      const pending = yield* readConstructVaultPending();
      expect(pending.notes).toHaveLength(50);
    }),
  );
});
