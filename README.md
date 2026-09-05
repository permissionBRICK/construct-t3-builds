# Construct T3 Code builds

This public repository owns the build workflow and binary releases for
[The Construct](https://github.com/permissionBRICK/The-Construct)'s patched T3 Code.
It does not fork the patch inventory. Every build reads an exact public Construct
commit and an exact upstream stable tag.

Every 30 minutes (at :17 and :47), on pushes here, and on manual workflow dispatch:

1. Resolve `t3@latest` from npm and hash the relevant Construct build inputs.
2. Reuse an existing complete release for that version and patch/recipe hash.
   **Unrelated Construct commits do not rebuild binaries.** Nightly-only edits do
   not invalidate a release built with the stable inventory.
3. If a build is needed, check the complete `release` inventory against the exact
   stable source. If it fails, try the complete prepared `nightly` inventory
   against that same stable tag. Never mix inventories or install a nightly
   upstream version into the stable channel.
4. Build the patched server/web/Desktop once. Package a Linux runtime with its
   native dependency closure and pinned Node, plus the unsigned Windows installer.
5. Extract the Linux package into a temporary directory and verify CLI startup,
   a real native PTY, and the served web UI. Verify the Windows PE and NSIS archive.
6. Upload assets to a draft release, download them again to verify checksums,
   then publish the complete pair as latest. Patch/build failures leave the
   previous published release untouched. Jarvis Lite repairs are picked up on
   the next poll after they reach Construct main.

The Windows installer is built on Ubuntu using Wine; CI does not exercise the
interactive Windows installation UI. Linux targets Ubuntu 24.04 x64. The bundled
Node runtime prevents global Node upgrades from breaking native dependencies.

## Assets and identity

- `T3Code-Construct-Setup.exe`
- `t3code-server-linux-x64.tar.gz` (`bin/t3` is the entry point)
- `manifest.json` (exact versions, commits, inventory, identity, asset URLs/hashes)
- `SHA256SUMS`

Tags are immutable identities: `t3-<upstream version>-<full build hash>`.
Fetch `/releases/latest/download/manifest.json` to select the last validated pair,
then use its immutable asset URLs. Always verify SHA-256 before installing.

The source patch hash comes from Construct's `t3_build_integration_hash`: selected
inventory, overlays, source transformer, runtime patchers, and artifact recipe.
The publisher recipe hash covers `config.json`, `scripts/build.sh`, and
`scripts/package-linux.mjs`. `patchHash` in the distributed manifest combines both
so a packaging/runtime change also updates the host. `sourcePatchHash` retains the
original Construct hash. `buildHash` additionally includes the upstream version.
Commit IDs are provenance, never cache keys. Workflow/docs/test changes do not
invalidate binaries. Change `formatVersion` in config for an explicit migration.

Package downloads, Cargo compilation, and Electron downloads use Actions caches
across releases. JavaScript task caches are not enabled: testing three successive
releases found no cross-release build-task hits.

## Credentials and triggers

There are **no cross-repository secrets**. Public Construct/upstream reads need no
private credential. Publishing and the monthly activity marker use this repo's
own automatically supplied `GITHUB_TOKEN` (`contents: write`). The build step
receives no GitHub token and checkouts do not retain credentials.

Polling is intentional: a public upstream release cannot directly trigger another
repository's workflow without the upstream cooperating or a dispatch credential.
GitHub schedules can be delayed. A monthly metadata commit prevents GitHub's
60-day inactivity cutoff for public scheduled workflows; it is excluded from all
binary hashes. No Construct release entries are created.

## Development

Python 3.11+, Node from `.node-version`, Bash, and Git are required.
`python3 -m unittest discover -s tests -v` tests reuse and inventory selection.
`python3 scripts/publisher.py plan --construct /path/to/construct` writes
`work/plan.json`. `sudo env PATH="$PATH" HOME="$HOME" bash scripts/build.sh "$PWD/work"`
builds in isolation; it never changes the machine's installed T3 launcher/service.
The builder needs Ubuntu build packages, Wine, Rust, and `p7zip-full` for archive
validation. Publishing is a separate authenticated command:
`python3 scripts/publisher.py publish`.
