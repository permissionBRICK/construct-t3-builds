# Nightly 20260915.1752: the launcher false alarm, third recurrence

The upstream patch watch reported `construct-t3park-patch.mjs: anchors not
found exactly once` for `0.0.41-nightly.20260915.1752`. The report reproduces
only against the npm package's 27-line launcher `dist/bin.mjs` — the same
finding as the September 14 and September 15 notes, which stand. The launcher
string is unchanged in 1752: `require.resolve("@t3code/t3-" ...)` occurs
exactly once, `status` adds `launcher: true` with the detail naming the
source-built patch target, and `apply` refuses with exit 2 and that
explanation. The watch runs from `main`, which does not yet carry the
launcher diagnosis, and its bundle check reads only `compatible`, so the
generic "anchors not found exactly once" reason repeats for every nightly
until the check inspects the source-built bundle (or honours `launcher`).

The nightly inventory itself is compatible with the target tag. All work used
isolated clones; no live installation was touched.

## Verification against v0.0.41-nightly.20260915.1752 (commit 50ff4c371)

- The nightly inventory (46 overlays + 172 transforms) applied to the pristine
  tag with 218 operations, no optional skips. A second application reported
  zero operations, 218 already present. Six files the transforms hook into
  changed upstream (`ws.ts`, `serverRuntimeStartup.ts`,
  `ProviderRuntimeIngestion.ts`, `server.ts`, `ChatView.tsx`,
  `ChatComposer.tsx`); all transforms matched, several through lenient
  re-indentation, with no conflicts.
- `pnpm install --no-frozen-lockfile`,
  `node scripts/update-release-package-versions.ts`, and `pnpm run
  build:bundle` in `apps/server` produced `dist/bin.mjs` (8.35 MB). Both
  runtime patchers reported it compatible, applied, and reapplying both left
  the bundle byte-for-byte unchanged; `node --check` passed and the patched
  server reported `t3 v0.0.41-nightly.20260915.1752` for `--version`.
- Focused suites in the patched tree: Claude adapter 127 tests; the changed
  hook files' suites (runtime startup, ingestion, voice input, omniloop, disk
  space) 156 tests; `apps/server` `pnpm run typecheck` exits clean.

Construct checks passed on the branch:

- `node test/t3park-patch.test.mjs` (16, including the launcher guard)
- `node test/t3-source-transform.test.mjs`, `node test/t3-source-contract.test.cjs`
- `node test/t3-build-cache.test.mjs`, `node test/t3-capacity-retry.test.mjs`
- `node extension/test/t3-opencode-monitor-patch.test.mjs`
- `bash test/t3-build-node.test.sh`, `bash test/t3-build-diskcheck.test.sh` (89)
- `bash test/t3-overlay.test.sh` (3/3 skip mode), `python3 -m unittest discover -s tests -v` (8)

Environment notes for reproducibility: Node 26.8.1 toolchain with
`LD_LIBRARY_PATH` pointing at the bundled libatomic, gcc wrappers from
`~/toolchains/gcc.env` (this container has no build-essential), and a
node-pty@1.1.0 `pty.node` reused from an earlier build as
`prebuilds/linux-x64/pty.node` so the install script skips node-gyp.

## What would end this loop

The watch's `verifyT3Bundle` probes `npm pack t3@<version>`'s
`package/dist/bin.mjs`. Since `0.0.41-nightly.20260914.1707` that file carries
no server code, so no honest patcher status can call it compatible. The check
must validate the source-built `apps/server/dist/bin.mjs` (the build recipe
applies both patchers there), or at minimum treat a `launcher: true` status as
"probe not applicable" instead of an upstream conflict. Until then, every new
nightly tag re-raises this false alarm while the inventory remains compatible.
