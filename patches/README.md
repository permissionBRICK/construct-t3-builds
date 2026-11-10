# Construct's T3 Code source inventories

`bin/build-t3code.sh` clones the upstream `t3code` tag published on the selected npm
channel and applies the inventory of that channel before building the VM server and
the Windows Desktop installer:

- `t3code-release/` — written against the **latest stable release** only.
- `t3code-nightly/` — written against the **latest nightly** only.

Each inventory holds `overlays/` (files Construct adds, copied verbatim; an upstream
file with the same path is a conflict) and `source-transforms.json` (the guarded edits
to upstream files, applied by `bin/apply-t3code-source.mjs apply|status --source
<checkout> --manifest <file> --overlays <dir>`).

## The rule for every transform, and for every repair

**As small and as narrow as possible, fixed on exactly the thing it changes, so that
any other upstream change avoids breaking it. Never any logic for more than one state
of the upstream code base.**

Concretely:

- An inventory targets the latest tag of its channel and nothing else. There are no
  version checks, no anchor alternatives, no fallbacks for older or newer trees. When
  upstream changes the code a transform hooks into, that is a conflict, and the repair
  rewrites the transform for the new shape. It does not keep the old one around.
- The two inventories are maintained separately. They will mostly look alike; that is
  fine. A fix for one is ported to the other by editing that inventory against its own
  tag, not by making one transform serve both.
- Do not add context "for safety": every extra byte in an anchor is one more way for
  an unrelated upstream edit to break the patch.
- Never anchor on a neighbour. An anchor is the thing the change integrates with: the
  list, record, union or JSX element it adds to (its opening line), or the declaration
  it changes. A sibling entry, an unrelated import or the function next door gets
  renamed or moved by upstream without touching what Construct needs.
- Anchor on names, not on shapes: `const handleAction`, not
  `const handleAction = useCallback((event: Event) => {`; no parameter lists, values,
  `export`/`async` modifiers or dependency arrays unless the change is about them.

## Transform format (manifest version 2)

```jsonc
{ "path": "a.ts", "after":  "<anchor line>", "insert": "<full lines>\n" }
{ "path": "a.ts", "before": "<anchor line>", "insert": "<full lines>\n" }
{ "path": "a.ts", "find":   "<exact text>",  "replace": "<text>" }
{ "path": "a.ts", "import": "<import statement(s)>\n" }
```

- **Imports without an anchor.** `import` places its text before the file's first
  top-level `import` or `export *` line (a shebang or header comment stays above it).
  Module imports and re-exports are hoisted, so their position does not matter, and
  anchoring them after some upstream import only breaks when upstream reorders its
  imports.

- **Line-based inserts.** `after`/`before` name a line; the insert text (complete lines
  carrying their own indentation) goes after or before that line.
- **Indentation-free anchors.** Leading whitespace on every anchor line is ignored when
  matching, so re-indented upstream code still matches. Multi-line anchors are allowed
  but should be the exception.
- **Exactly one match** for an anchor or `find`, unless a `scope` is given: then the
  first match *after* the scope text is used (`"scope": "function Foo"` for an anchor
  such as `</>` that repeats in the file).
- **`every: true`** inserts next to every occurrence (a prop passed at several identical
  call sites).
- **Idempotent.** An insert whose text is already present, or a `replace` text already
  present, is a no-op, so an interrupted build can re-apply the same tree.
- **`optional: true`** — a missing file or anchor is skipped instead of failing. Used
  for upstream *test* files only: they never affect the built server/Desktop app, so
  they must never block a build.

Guidelines when writing or repairing a transform:

- Prefer an insert over a replace; prefer a whole-line anchor over a fragment; prefer
  an anchor line that names the thing we integrate with (an import, an RPC method, a
  schema field) over structural lines such as `});` or `}`.
- Names only Construct uses get their **own** import statement, as an `import`
  transform (a duplicate module import is fine for TypeScript). A name upstream might import itself is merged into
  the upstream import line with `find`/`replace`, so that an upstream change surfaces
  as a conflict instead of a duplicate-identifier build error.
- One import per transform; one union member or one record entry per transform.
  Independent inserts stay independent.

`status` prints JSON with `compatible`, the per-transform `results`
(`applied|pending|skipped|conflict`, with `detail: "lenient"` when the anchor matched
through re-indentation) and the list of `conflicts`.

## What the inventories add to T3 Code

- **Voice input** (`voiceInput.*` RPCs, client or host capture): Claude Code's live
  transcription as one of T3's own transcription models. A server with Claude voice
  input lists "Claude" (`construct/claude`, advertised as `voiceInputSpeechModel`) first
  among its models in Settings → Voice, and serves T3's own speech endpoints with it
  (`constructClaudeSpeech` wraps T3's `SpeechService`): a recording uploaded after Stop
  (the stock mobile app) is replayed to Claude's voice service at 4x real time, and T3's
  live `/ws/voice` stream (stock web and desktop clients) shows Claude's text in T3's
  preview. Patched clients instead transcribe live into the draft: while the chosen
  destination is an environment whose model is Claude (checked when each recording
  starts), T3's microphone button, recording pill, dictation shortcut and
  send-after-dictation drive the `useConstructVoiceInput` session; any other model or
  destination uses T3's recorder unchanged. The composer imports its speech input from
  the `constructSpeechInput` wrapper and lends it the draft, which is its only
  ChatComposer change. T3's other voice fields (pull request comments, previews) use
  T3's own flow with whatever model the environment uses, Claude included.
  The environment that runs Claude can be a Construct VM or a Desktop app's own backend.
  Desktop-managed backends enable it by default, using the desktop microphone
  and the Claude Code login in that backend's environment. Remote servers keep
  the `CONSTRUCT_T3_VOICE_INPUT=true` opt-in; an explicit `false` disables voice
  on either backend. Local Desktop use does not require a Construct VM.
  Servers with the opt-in select Claude as their model when no installed model is
  selected, and advertise `voiceInputDefault`. A device that has never chosen a voice
  destination chooses the first such server it is connected to, once (a local marker
  records it). An existing choice, including Off, is never replaced, and a Desktop
  backend alone never becomes the default. The model is per environment, so choosing
  another model there moves every device using that environment to T3's recorder.
  Servers built before the Claude model existed are offered as the `claude-code`
  destination kind ("Claude via <environment>"). A device whose saved choice is that kind
  moves to the environment itself once that server lists Claude, selecting Claude as the
  environment's model first so nothing changes for it.
  The Microphone chosen in Voice settings applies; T3's language, vocabulary, filler-word
  and cleanup options do not, since the transcript comes from Claude as spoken (its
  language is `CLAUDE_CODE_VOICE_LANGUAGE`, English by default).
  Client recordings retain up to 30 seconds of unacknowledged PCM and reattach the
  same server session after connection loss. Ordered byte offsets make retries
  idempotent; Stop flushes capture and drains uploads before closing transcription.
  The server retains detached sessions and completed results for 30 seconds.
  Microphone inactivity (35 seconds) is separate from transcription latency;
  the existing five-minute recording limit has an explicit stop reason. Browser
  microphone interruptions and unexpected provider socket closure report errors.
  An initial voice handshake rejected with HTTP 401 initializes Claude without a
  user message to refresh its login. Claude saves the new token after its
  initialization completes, so the session waits until the saved token differs
  from the rejected one, then retries once with it. Concurrent failures share the
  refresh, which times out after 15 seconds.
  Reconnection after transcription has begun is not attempted.
  The Claude voice service revises its transcript only when a stream closes, so
  after 2 seconds of quiet audio (measured in recorded audio; the threshold
  adapts to background noise) following transcribed speech, the session closes
  the stream for finalization and continues on a new one. Soft speech can pass
  the level check, so the stream's transcript must also have stayed unchanged
  for the last second of audio. Recording continues without interruption in
  the UI. The chunk that completes the pause and all later audio are queued for
  the new stream while it connects. No audio is sent to both streams, because
  the service would transcribe it twice and repeat the words at the join. The
  text of each stream is joined in order; a stream that does not finalize within
  3 seconds keeps its last text.
  T3's controls show "Preparing" while voice input starts and "Transcribing" while the
  final transcript is pending. They show recording, with T3's level meter, only once
  speech is kept: the transcription stream is open and the microphone has delivered
  audio (for the host bridge, the first level event from the server). T3's Cancel
  (or Escape) ends the session at once and keeps the text already written.
  Alt+Q is a default binding of T3's dictation command beside its own Ctrl+Shift+D:
  tap to toggle, or hold and release to stop (T3's Dictation shortcut setting). A
  keybindings file that still has T3's default dictation binding gets Alt+Q once
  through T3's late-default migration; a customised one is left alone. It matches the
  physical Q key without Ctrl, so AltGr+Q still types "@".
  The composer stays editable while recording and finishing transcription, so
  focus and Alt+Q retain their normal behavior. Text edits do not cancel voice
  input. Transcript updates use the session's latest requested text rather than
  the editor's delayed rendered snapshot and may overwrite manual edits made
  during recording. Switching the target thread or question still cancels.
  Enter or Send stops recording and submits automatically after the final
  transcript reaches the draft. Repeated submits while finishing send only once;
  a failed recording or a changed thread or question cancels the pending send.
  Shift+Enter and the microphone's Stop control keep their normal behavior.
  Regression coverage includes delayed/lost uploads, scope cancellation and
  reattachment, final-result replay, offline Stop, and real browser AudioWorklet
  capture/flush. The publisher runs the voice unit tests for each pair; the overlay
  browser test (`vp test run --project browser src/voice`) drives the session through
  T3's real button, pill and shortcut and is run by hand.
- **Public base URL** (`T3CODE_PUBLIC_BASE_URL` for pairing URLs behind the TLS proxy).
- **Construct updates** in the Desktop app: update Construct, reprovision a VM that is
  behind the installed Construct, or update T3 Code alone (`Update-T3Code.ps1 -Mode
  quick`) when a newer build of this repository is published for the channel. The app
  reads the same release manifests the VM installs from and compares their
  `desktopVersion` with its own, so a release counts once its build is published and a
  rebuild of the same release counts too. **Update T3 Code** updates this app and every
  Construct VM it is connected to (matched by address or by the link marker's environment
  id); a stopped VM is left alone, and with none connected nothing is launched. Several
  VMs run one after another in one console, each in its own PowerShell, because the first
  run installs the Desktop app and closes it. A reprovision popup resolves the active
  thread's linked remote to a Construct instance, shows its name, and launches that exact
  instance, using that VM's provisioning marker and T3 channel. Without an unambiguous
  match, no reprovision is offered, but the T3 Code update still is. Switching threads
  replaces the offer; host Construct updates remain available independently of the
  active thread.
- **Auto-link** (`ConstructAutoLink`, Windows Desktop app): every Construct VM of the PC
  that runs T3 and is not yet a remote environment is linked on its own. The main process
  runs `Get-ConstructT3PairingLink.ps1` hidden to mint a link over SSH. A marker in the
  instance's state keeps a connection the user removed from being added back. A linked VM
  (matched by its paired address, or else by the environment id its marker recorded, which
  also covers a connection the user paired through a proxy of their own) whose session still has T3's
  old permission set (upstream's
  `sessionHasLegacyPermissions`, for example after an upgrade to 0.1) is paired again once
  per app session. The new token is redeemed for the same environment at the address of the
  paired route that owns the saved credential, never at a LAN route T3 learned on its own,
  so the credential is replaced in place. For those VMs a layout effect stores upstream's
  dismissal of its "Permissions have changed … pair again" notice before the notice asks
  (the notice asks outside React as soon as a session settles, so the dismissal is
  stored once the VM is known; a notice shown before the VM list loaded stays). A
  failure shows an error and is retried on the next app start. Servers that are not
  Construct VMs of this PC keep upstream's notice.
- **Editor links to Construct VMs** (`constructRemoteOpen.ts`, Desktop app): "Open in"
  and file links for a linked Construct VM of this PC go through the ssh alias Construct
  wrote for it into the PC's `~/.ssh/config` (`ssh-remote+<hostAlias>`, the Companion's
  own link, with the user from that block). Upstream takes the first host the server
  advertises; a VM without Tailscale advertises `root@<hostname>.local`, which resolves
  only on the VM's own network. The VM is found as the re-link finds it: by the paired
  route's address, else by the auto-link marker's environment id. Other servers and
  browsers keep upstream's host.
- **Disk-space warning** (`construct.diskSpace` RPC, capability `constructDiskSpace`):
  a prompt when the VM disk is almost full or only the root reserve is left.
- **Key vault banner** (`construct.vaultPending` RPC, capability `constructVaultPending`):
  while an agent's `construct secret` call waits for the user's approval, every open
  client shows a banner that links to the approval page (or names the Companion when
  there is no link). The server only reads the CLI's notes in
  `/run/construct/vault-pending` (`CONSTRUCT_VAULT_PENDING_DIR` overrides it) and
  validates them as untrusted input; clients ask every 3 seconds while the page is visible.
  In the Desktop app on Windows, the banner also lists the approvals the local Construct
  Companion waits on, with the Companion's own texts and Deny and Approve buttons. Approve
  is enabled one second after an item appears. The main process reads the Companion's
  endpoint file (`%LOCALAPPDATA%\The-Construct\companion\endpoint.json`), calls its
  loopback `/v1/vault/approvals` routes and keeps the bearer token to itself. A VM note
  for the same request appears once, as the Companion item. The Companion learns of a
  hosted VM's request only on its next host poll, so while it answers, the app holds back
  a VM note it does not list yet for up to 10 seconds after the note first arrived. It asks
  the Companion once when the note arrives and then every second until the approval shows
  or the 10 seconds end. A note without a match then shows with its link or hint. Without
  an answer from the Companion, notes show at once. Every poll shows only what
  the Companion lists at that moment, so a request answered anywhere else disappears on
  the next poll. A request decided in the banner disappears at once, and a result line
  reports the Companion's answer. After each Companion answer, while the page is visible
  and the user has not closed the banner, the app reports the ids of the approvals shown
  inline (an empty list when none) to `POST /v1/vault/approvals/displayed`, so the
  Companion holds back its own pop-out. A hidden page or a closed banner reports nothing,
  and the Companion's pop-out takes over. Browsers and the PWA keep the link and hint.
- **Omniloop tab** (`construct.omniloop*` RPCs, capability `constructOmniloop`, proxy
  route `/construct/omniloop/<ticket>/*`): the omniloop dashboard of the thread's own
  VM in the right panel, served through the T3 server behind a ticket, plus a composer
  banner and tab badge for the workflows the thread started.
- **Session renewal** (`POST /construct/session/renew`): a paired client in use during the
  last 7 days of its 30-day session gets 30 days from now, on the same session. A session
  nobody uses in that week expires as before. The server re-signs upstream's own token
  claims with the new `exp` and updates the session row. It checks the new token with
  upstream's verifier first, so if upstream changes its token format, the server does not
  renew. The response's `Set-Cookie` renews a browser's cookie session, and the web app
  asks when it loads. Saved bearer connections (the Desktop app, or a browser paired with
  another server) ask when they connect and store the renewed token. Every six hours the
  web app checks both again, so a connection that stays up into its last week also renews
  and reconnects once with the new token. A server without the route answers 404 and the
  client keeps its token. The patch leaves T3 Connect's proof-bound tokens alone because
  they refresh on their own.
- **Codex capacity retry and OpenCode monitor.** Both channels run upstream's
  orchestration v2 server and build them into its source (`constructCapacityRetry.ts`,
  `constructOpenCodeMonitor.ts`). The entry bundle is marked, so the runtime patchers
  in `extension/vm/` report it compatible and leave it unchanged. There is no Claude
  usage-limit park; upstream's "Auto-resume limited threads" setting replaces it.
- **New-project folder** (`constructProjectsRoot.ts`): on a Construct VM, "New project"
  creates its folder in the VM's `WORKSPACE_ROOT` from `/etc/construct/config.env`
  (`/root/repos` by default) instead of upstream's `~/.t3/projects`, so new projects sit
  beside the checked-out repos. Clients show that root as the server's `newProjectsRoot`,
  and link-started clones that use it land there too. The server reads the file once at
  startup. Only a server using the default T3 home (`~/.t3`) applies it. Test and
  isolated servers with their own base directory, and servers without Construct's
  config (the Desktop app's local and WSL backends), keep upstream's folder.

## Local build cache and Windows handoff

`bin/t3code-build-recipe.sh` owns artifact-producing commands. Its contents, the
source transformer, the selected channel inventory, and the two server patchers
form `patchHash`. The upstream T3 version plus that recipe identifies a build;
the Construct commit and the orchestration code in `bin/build-t3code.sh` do not.
Hash inputs use repository-relative paths and LF checkouts on Windows and Linux.
Changes to build semantics belong in the recipe so they invalidate artifacts.

For local builds, Windows provisioning sets `T3CODE_BUILD_MODE=server`. The guest compiles shared
server/web/Desktop JavaScript once and writes `server-manifest.json` under
`/var/lib/construct/t3code-desktop`. It skips all compilation on an unchanged
build. The host compares that identity with its per-user, cross-VM record at
`%LOCALAPPDATA%\The-Construct\artifacts\t3code\installed.json` before requesting
Windows packaging or downloading an EXE.

Only a host that needs an install requests `T3CODE_BUILD_MODE=desktop`. This stage
uses the prepared server's exact version/channel/recipe (no second npm channel
lookup), keeps its compiled bundle untouched, and writes the installer plus
`manifest.json`. A matching cached installer with a valid SHA-256 skips packaging.
Calling the driver directly without a mode retains the combined build behavior
(`all`), which only activates a new server after packaging succeeds.

The source cache is `/var/cache/construct/t3code-source`. pnpm's shared package
store survives source changes; Windows Cargo outputs and Wine setup now also
survive them in `/var/cache/construct/t3code-compiler`. Superseded source cleanup
keeps the previous active server until provisioning can restart it. These caches
survive reprovisioning, but a VM rebuild/reinstall removes them. JavaScript build
outputs are reused for an identical build; changed source still recompiles.

In local mode, the new recipe identity requires one rebuild per VM on first upgrade, and one
Desktop installation per Windows user. Subsequent VMs with the same T3 version,
channel, and recipe skip Windows packaging, download, and installation.

Focused verification (all use temporary fixtures, with no live service restart):

```sh
node test/t3-build-cache.test.mjs
pwsh -NoProfile -File test/t3-desktop-handoff.test.ps1
bash test/t3-build-diskcheck.test.sh
node extension/test/t3code.test.js
pwsh -NoProfile -File test/host-lib.test.ps1
```

CI can set `T3CODE_SOURCE_VERSION` to pin the exact upstream tag and
`T3CODE_INVENTORY=release|nightly` to select a whole inventory independently of
the output channel. The publisher selects the matching inventory for each channel. Desktop packaging retains the inventory from `server-manifest.json`.
The service restart key includes the upstream version as well as the patch hash.

## Prebuilt pairs

This repository publishes separate stable and nightly pairs on pushes to main.
Each channel uses only its own inventory. Construct downloads the latest validated
pair for its selected channel; local compilation remains an explicit option.
See [the publisher contract](../README.md) for identity, validation and discovery.

### Construct VM tool permission auto-approval

The server accepts command, file-read, file-change and permission requests when
its local `/etc/construct/config.env` contains a nonempty `AGENT_NAME` and
`T3CODE_AUTO_APPROVE=true`. Construct exposes this opt-in in its VM settings and
through `construct config set t3-auto-approve true`. Missing, unreadable or disabled
configuration leaves upstream behavior in place. The setting is read for each new
request; changing it needs no T3 restart and does not answer existing requests.

The shared provider-session event handler answers with `accept`, without creating
session-wide rules, and logs the request ID and kind. The request and response
remain in the normal event stream. Questions, authentication, runless trust/login
requests and MCP elicitation forms stay interactive. Provider denials that never
emit a request are outside this handler. Desktop and linked environments use
the policy of their executing server, never a client-wide preference.
