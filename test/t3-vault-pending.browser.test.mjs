// The key vault banner in Chromium with React and the real T3 toast UI; only the
// servers' `construct.vaultPending` answers and the environment list are fixtures, and,
// for the Desktop app, a stubbed `desktopBridge` that plays the local Companion.
// T3_TEST_SOURCE = patched upstream checkout with installed dependencies, T3_TEST_TOOLS =
// esbuild + playwright, T3_TEST_CHANNEL = release|nightly. T3_TEST_SCREENSHOTS=<dir> saves
// screenshots, styled with the checkout's built web CSS (apps/web/dist) when it has one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
const source = process.env.T3_TEST_SOURCE;
if (!source) throw new Error('Set T3_TEST_SOURCE');
const root = path.resolve(import.meta.dirname, '..');
const channel = process.env.T3_TEST_CHANNEL || 'release';
const shots = process.env.T3_TEST_SCREENSHOTS;
const toolRequire = createRequire(path.resolve(process.env.T3_TEST_TOOLS || '.', 'package.json'));
const {build} = toolRequire('esbuild');
const {chromium} = toolRequire('playwright');
const web = path.join(source, 'apps/web/src');
const overlay = path.join(root, `patches/t3code-${channel}/overlays/apps/web/src`);
// Keyed by the end of the import path, so `~/x` and `../x` hit the same fixture.
const mocks = {
  'state/entities': 'export const useServerConfigs=()=>window.fixture.configs;',
  'state/environments': 'export const useEnvironments=()=>({environments:window.fixture.environments});',
  'state/constructVaultPending': 'export const readConstructVaultPending={};',
  'state/use-atom-command': `import {AsyncResult} from 'effect/unstable/reactivity';
    import * as Cause from 'effect/Cause';
    const read=async({environmentId})=>{
      window.fixture.calls.push(environmentId);
      const notes=window.fixture.answers[environmentId];
      return notes===undefined?AsyncResult.failure(Cause.fail('offline')):AsyncResult.success({now:Date.now(),notes});
    };
    export const useAtomCommand=()=>read;`,
  composerDraftStore: 'export const useComposerDraftStore=select=>select({getDraftSession:()=>null}); export const DraftId={make:x=>x};',
  '@tanstack/react-router': 'export const useParams=({select})=>select?select({}):{};',
};
const mockFor = (spec) => Object.keys(mocks).find((key) => spec === key || (/^[.~]/.test(spec) && spec.endsWith(`/${key}`)));
const viteSuffixStubs = {name: 'vite-suffix-stubs', setup(b) {
  b.onResolve({filter: /\?(worker|url|raw|inline)$/}, (args) => ({path: args.path, namespace: 'vite-suffix'}));
  b.onLoad({filter: /.*/, namespace: 'vite-suffix'}, () => ({contents: 'export default "";'}));
}};
const fixtures = {name: 'fixtures', setup(b) {
  b.onResolve({filter: /.*/}, (args) => {
    const mock = mockFor(args.path);
    if (mock) return {path: mock, namespace: 'fixture'};
    if (args.path.startsWith('~/')) return b.resolve(`./${args.path.slice(2)}`, {kind: args.kind, resolveDir: web});
    // The overlay under test comes from this repository; whatever it imports that is not
    // an overlay file of its own resolves inside the patched checkout.
    if (!args.resolveDir.startsWith(overlay) && args.resolveDir !== root) return undefined;
    if (args.path.startsWith('.')) {
      const local = path.resolve(args.resolveDir, args.path);
      if (['.ts', '.tsx'].some((ext) => fs.existsSync(local + ext))) return undefined;
      return b.resolve(args.path, {kind: args.kind, resolveDir: path.join(web, path.relative(overlay, args.resolveDir))});
    }
    if (path.isAbsolute(args.path)) return undefined;
    return b.resolve(args.path, {kind: args.kind, resolveDir: path.join(web, 'components')});
  });
  b.onLoad({filter: /.*/, namespace: 'fixture'}, (args) => ({contents: mocks[args.path], loader: 'js', resolveDir: web}));
}};
const result = await build({
  stdin: {contents: `import {createRoot} from 'react-dom/client';
    import {ToastProvider} from ${JSON.stringify(path.join(web, 'components/ui/toast.tsx'))};
    import {ConstructVaultPendingNotification} from ${JSON.stringify(path.join(overlay, 'components/ConstructVaultPendingNotification.tsx'))};
    window.render=()=>createRoot(document.getElementById('root')).render(<ToastProvider><ConstructVaultPendingNotification /></ToastProvider>);`,
  loader: 'tsx', resolveDir: root},
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: {'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}'},
  plugins: [viteSuffixStubs, fixtures],
});
const distAssets = path.join(source, 'apps/web/dist/assets');
const css = fs.existsSync(distAssets) ? fs.readdirSync(distAssets).filter((name) => /^main-.*\.css$/.test(name)) : [];
const browser = await chromium.launch({headless: true, args: ['--no-sandbox'], ...(process.env.T3_TEST_CHROMIUM ? {executablePath: process.env.T3_TEST_CHROMIUM} : {})});
try {
  const errors = [];
  const openPage = async () => {
    const opened = await browser.newPage({viewport: {width: 1280, height: 720}});
    opened.on('pageerror', (error) => errors.push(error.message));
    await opened.setContent('<div id="root"></div>');
    for (const name of css) await opened.addStyleTag({path: path.join(distAssets, name)});
    return opened;
  };
  const page = await openPage();
  await page.evaluate(() => {
    window.visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {get: () => window.visibility});
    const capable = {environment: {capabilities: {constructVaultPending: true}}};
    window.fixture = {
      configs: new Map([['env-a', capable], ['env-b', capable], ['env-stock', {environment: {capabilities: {}}}]]),
      environments: [{environmentId: 'env-a', label: 'Agent VM'}, {environmentId: 'env-b', label: 'Other VM'}],
      calls: [],
      answers: {'env-b': []},
    };
    window.note = (id, over = {}) => ({id, vm: 'agent-vm', op: 'request', names: ['github-token'], reason: 'publish the release',
      deadline: Date.now() + 5 * 60_000 + 30_000, approveUrl: `https://host.example:7462/vault/#request=${id}`, ...over});
  });
  const banner = page.locator('[data-slot="construct-vault-pending"]');
  const toast = page.locator('[data-slot="toast-title"]');
  const answer = (env, script) => page.evaluate(([env, script]) => { window.fixture.answers[env] = eval(script); }, [env, script]);
  const shot = async (name) => {
    if (!shots) return;
    await page.waitForTimeout(800); // the toast's enter/resize transitions
    await page.screenshot({path: path.join(shots, `vault-pending-${channel}-${name}.png`)});
  };

  await answer('env-a', '[note("one", {names: ["github-token", "npm-token"]})]');
  await page.addScriptTag({content: result.outputFiles[0].text});
  await page.evaluate(() => window.render());
  await banner.waitFor({timeout: 5_000});
  assert.equal(await toast.textContent(), 'Key vault: github-token, npm-token waiting for your approval');
  assert.match(await banner.textContent(), /The agent on agent-vm · publish the release · 5 min left/);
  const approve = banner.locator('a', {hasText: 'Approve'});
  assert.deepEqual(await approve.evaluate((a) => [a.href, a.target, a.rel]),
    ['https://host.example:7462/vault/#request=one', '_blank', 'noopener noreferrer']);
  const calls = await page.evaluate(() => window.fixture.calls);
  assert.ok(calls.includes('env-a') && calls.includes('env-b') && !calls.includes('env-stock'), 'only Construct servers are asked');
  await shot('single');

  // Without an approval link: the Companion hint, and no button.
  await answer('env-a', '[note("one", {approveUrl: null, reason: ""})]');
  await page.waitForFunction(() => document.querySelector('[data-slot="construct-vault-pending"]')?.textContent.includes('Companion'), null, {timeout: 5_000});
  assert.match(await banner.textContent(), /The agent on agent-vm · 5 min left.*Approve it in the Construct Companion on your PC\./);
  assert.equal(await banner.locator('a').count(), 0);
  await shot('companion');

  // Several requests on two VMs: one banner, the three most urgent, "and 2 more".
  await answer('env-a', '[note("a1", {deadline: Date.now() + 90_000, approveUrl: null}), note("a2", {names: ["npm-token"]}), note("a3"), note("a4")]');
  await answer('env-b', '[note("b1", {vm: "other-vm", names: ["docker-hub"], reason: "push the image", deadline: Date.now() + 40_000})]');
  await toast.filter({hasText: '5 requests'}).waitFor({timeout: 5_000});
  assert.equal(await toast.count(), 1);
  const text = await banner.textContent();
  assert.match(text, /^docker-hub.*other-vm · push the image · \d+ s left/);
  assert.match(text, /and 2 more.*Approve it in the Construct Companion on your PC\./);
  assert.equal(await banner.locator('a', {hasText: 'Approve'}).count(), 2);
  await shot('several');
  await page.setViewportSize({width: 390, height: 844});
  await shot('several-phone');
  await page.setViewportSize({width: 1280, height: 720});

  // Hidden while the page is: no requests at all, and one at once when it shows again.
  await page.evaluate(() => { window.visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  const before = await page.evaluate(() => window.fixture.calls.length);
  await page.waitForTimeout(3_500);
  assert.equal(await page.evaluate(() => window.fixture.calls.length), before, 'no polling while hidden');
  await page.evaluate(() => { window.visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction((count) => window.fixture.calls.length > count, before, {timeout: 1_000});

  // Closing it hides these requests; a new one brings the banner back.
  await page.locator('[data-slot="toast-close"]').click();
  await banner.waitFor({state: 'detached', timeout: 5_000});
  await page.waitForTimeout(3_500);
  assert.equal(await banner.count(), 0, 'stays hidden for the same requests');
  await answer('env-b', '[note("b2", {vm: "other-vm"})]');
  await toast.filter({hasText: '5 requests'}).waitFor({timeout: 5_000});

  // An unreachable server keeps its last answer; once nothing waits, the banner goes away.
  await answer('env-b', 'undefined');
  await page.waitForTimeout(3_500);
  assert.equal(await toast.count(), 1);
  await answer('env-a', '[]');
  await answer('env-b', '[]');
  await banner.waitFor({state: 'detached', timeout: 5_000});
  // In a browser (no desktop bridge) nothing is decided inline.
  assert.equal(await page.locator('[data-slot="construct-vault-approval"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS ${channel}: vault banner links, Companion hint, list cap, visibility pause, hide and auto-clear`);
  await page.close();

  await desktopFlow(await openPage());
  assert.deepEqual(errors, []);
  console.log(`PASS ${channel}: Desktop inline approval through the Companion (matching, arming, optimistic decide, answered elsewhere, host and Companion failures, displayed reports only while visible)`);
} finally {
  await browser.close();
}

// The Desktop app: the Companion's approvals inline, through a stubbed desktop bridge.
async function desktopFlow(page) {
  await page.evaluate(() => {
    window.visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {get: () => window.visibility});
    window.fixture = {
      configs: new Map([['env-a', {environment: {capabilities: {constructVaultPending: true}}}]]),
      environments: [{environmentId: 'env-a', label: 'Agent VM'}],
      calls: [],
      answers: {},
    };
    window.note = (id, over = {}) => ({id, vm: 'agent-vm', op: 'request', names: ['github-token'], reason: 'publish the release',
      deadline: Date.now() + 5 * 60_000 + 30_000, approveUrl: null, ...over});
    window.approval = (id, over = {}) => ({id, instance: 'agent-vm', vm: 'agent-vm', kind: 'local', host: null,
      requestId: null, hostRequestId: null, op: 'request', title: 'Key vault request from agent-vm',
      message: 'The agent asks for github-token.\nReason: publish the release', action: 'Approve', deny: 'Deny',
      names: ['github-token'], createdAt: Date.now(), deadline: Date.now() + 4 * 60_000 + 30_000, ...over});
    // The Companion: its current list, decisions (and lists) held until the test releases
    // them, and the displayed reports with the page's visibility at the time.
    window.companion = {answer: {available: true, approvals: []}, lists: 0, decisions: [], hold: false, reply: {ok: true}, release: null,
      holdList: false, releaseList: null, reports: []};
    window.desktopBridge = {
      constructVaultApprovals: () => {
        window.companion.lists++;
        const answer = structuredClone(window.companion.answer);
        return new Promise((resolve) => {
          window.companion.releaseList = () => resolve(answer);
          if (!window.companion.holdList) window.companion.releaseList();
        });
      },
      constructVaultDisplayed: async (ids) => {
        window.companion.reports.push({ids: [...ids], visibility: window.visibility});
      },
      constructVaultDecide: (id, decision) => {
        window.companion.decisions.push([id, decision]);
        return new Promise((resolve) => {
          window.companion.release = () => resolve(structuredClone(window.companion.reply));
          if (!window.companion.hold) window.companion.release();
        });
      },
    };
  });
  const banner = page.locator('[data-slot="construct-vault-pending"]');
  const toast = page.locator('[data-slot="toast-title"]');
  const items = page.locator('[data-slot="construct-vault-approval"]');
  const line = page.locator('[data-slot="construct-vault-result"]');
  const item = (title) => items.filter({hasText: title});
  const set = (script) => page.evaluate((script) => eval(script), script);
  const shot = async (name) => {
    if (!shots) return;
    await page.waitForTimeout(800);
    await page.screenshot({path: path.join(shots, `vault-pending-${channel}-${name}.png`)});
  };
  const nextList = async () => {
    const lists = await page.evaluate(() => window.companion.lists);
    await page.waitForFunction((count) => window.companion.lists > count + 1, lists, {timeout: 8_000});
  };
  const reportCount = () => page.evaluate(() => window.companion.reports.length);
  const lastReport = () => page.evaluate(() => window.companion.reports.at(-1)?.ids ?? null);
  const nextReport = async () => {
    const count = await reportCount();
    await page.waitForFunction((count) => window.companion.reports.length > count, count, {timeout: 5_000});
    return lastReport();
  };

  // A local VM's request (its note is the approval's requestId), a hosted VM's request (the
  // note links the host's approval id) and a request the Companion does not know.
  await set(`window.fixture.answers['env-a'] = [
    note('local-1'),
    note('note-h1', {names: ['npm-token'], approveUrl: 'https://host.example:7462/vault/#request=host-appr-1'}),
    note('unknown', {vm: 'other-vm', names: ['docker-hub'], deadline: Date.now() + 9 * 60_000})];
    window.companion.answer.approvals = [
      approval('c-local', {requestId: 'local-1', title: 'Key vault request from agent-vm', message: 'The agent asks for github-token.\\nReason: <b>publish</b> the release'}),
      approval('c-host', {kind: 'host', host: 'home', hostRequestId: 'host-appr-1', names: ['npm-token'], title: 'Hosted key vault request', message: 'The agent on agent-vm asks for npm-token.'})];`);
  await page.addScriptTag({content: result.outputFiles[0].text});
  await page.evaluate(() => window.render());
  await items.first().waitFor({timeout: 5_000});
  assert.equal(await toast.textContent(), 'Key vault: 3 requests waiting for your approval');
  assert.equal(await items.count(), 2, 'two Companion approvals, each once');
  const local = item('Key vault request from agent-vm');
  // Plain text: markup in the Companion's message is shown, never interpreted.
  assert.match(await local.textContent(), /Reason: <b>publish<\/b> the release/);
  assert.equal(await local.locator('b').count(), 0);
  assert.match(await local.textContent(), /The agent on agent-vm · 4 min left/);
  // Approve waits a second after the item shows; Deny does not.
  assert.equal(await local.getByRole('button', {name: 'Approve'}).isDisabled(), true, 'Approve starts disabled');
  assert.equal(await local.getByRole('button', {name: 'Deny'}).isDisabled(), false);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="construct-vault-approval"] button')]
    .every((button) => !button.disabled), null, {timeout: 2_500});
  // The matched notes are not shown again (no approval link); the unknown one keeps the hint.
  assert.equal(await banner.locator('a').count(), 0);
  assert.match(await banner.textContent(), /docker-hub.*The agent on other-vm · publish the release · \d+ min left/);
  assert.match(await banner.textContent(), /Approve it in the Construct Companion on your PC\./);
  // Each answer tells the Companion which of its approvals show here, never the notes.
  assert.deepEqual((await nextReport()).toSorted(), ['c-host', 'c-local']);
  await shot('desktop');

  // Approve: the item goes at once, every other button waits while the decision is sent.
  const hosted = item('Hosted key vault request');
  await set('window.companion.hold = true');
  await local.getByRole('button', {name: 'Approve'}).click();
  await local.waitFor({state: 'detached', timeout: 1_000});
  assert.equal(await line.textContent(), 'Approving github-token for agent-vm…');
  assert.equal(await hosted.getByRole('button', {name: 'Deny'}).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.companion.decisions), [['c-local', 'approve']]);
  await set('window.companion.release()');
  await line.filter({hasText: 'Approved github-token for agent-vm.'}).waitFor({timeout: 1_000});
  // The items moved up: Approve arms again before it can be clicked.
  assert.equal(await hosted.getByRole('button', {name: 'Deny'}).isDisabled(), false);
  assert.equal(await hosted.getByRole('button', {name: 'Approve'}).isDisabled(), true, 're-armed after the shift');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="construct-vault-approval"] button')]
    .every((button) => !button.disabled), null, {timeout: 2_500});
  assert.equal(await toast.textContent(), 'Key vault: 2 requests waiting for your approval');
  await shot('desktop-approved');
  // The Companion still lists it for a moment: it stays gone, and is no longer reported.
  await nextList();
  assert.equal(await local.count(), 0);
  assert.deepEqual(await lastReport(), ['c-host']);
  // Then the Companion drops it, while the VM's note lingers until its CLI hears the answer.
  await set(`window.companion.answer.approvals = window.companion.answer.approvals.filter((a) => a.id !== 'c-local')`);
  await nextList();
  assert.equal(await items.count(), 1);
  assert.doesNotMatch(await banner.textContent(), /The agent on agent-vm · publish the release/);

  // Answered elsewhere (the Companion's dialog, the phone or the host): gone on the next list,
  // and its note (with its approval link) does not come back meanwhile.
  await set(`window.companion.answer.approvals = []`);
  await nextList();
  assert.equal(await items.count(), 0);
  assert.equal(await banner.locator('a').count(), 0);
  assert.equal(await toast.textContent(), 'Key vault: docker-hub waiting for your approval');
  assert.deepEqual(await lastReport(), [], 'visible, but none of its approvals shows');
  // Their CLIs heard the answers and removed their notes.
  await set(`window.fixture.answers['env-a'] = window.fixture.answers['env-a'].filter((n) => n.id === 'unknown')`);

  // Denied, but already answered elsewhere: gone, and the result line says so.
  await set(`window.companion.hold = false; window.companion.reply = {ok: false, reason: 'already-decided'};
    window.companion.answer.approvals = [approval('c-3', {names: ['pypi-token'], title: 'Third request'})]`);
  await item('Third request').waitFor({timeout: 5_000});
  await set('window.companion.hold = true');
  await item('Third request').getByRole('button', {name: 'Deny'}).click();
  await line.filter({hasText: 'Denying pypi-token for agent-vm…'}).waitFor({timeout: 1_000});
  await shot('desktop-sending');
  await set('window.companion.hold = false; window.companion.release()');
  await line.filter({hasText: 'pypi-token for agent-vm was already answered elsewhere.'}).waitFor({timeout: 2_000});
  assert.equal(await item('Third request').count(), 0);
  await set(`window.companion.answer.approvals = []`);

  // The host refused a hosted VM's decision: the item comes back to be answered again.
  const armedAgain = () => page.waitForFunction(() =>
    document.querySelector('[data-slot="construct-vault-approval"] button:last-child')?.disabled === false, null, {timeout: 2_500});
  await set(`window.companion.reply = {ok: false, reason: 'host-failed'};
    window.companion.answer.approvals = [approval('c-4', {kind: 'host', host: 'home', hostRequestId: 'host-appr-4', names: ['ssh-key'], title: 'Fourth request'})]`);
  const fourth = item('Fourth request');
  await fourth.waitFor({timeout: 5_000});
  await armedAgain();
  await fourth.getByRole('button', {name: 'Approve'}).click();
  await line.filter({hasText: 'The host could not be reached for ssh-key for agent-vm. Try again, or answer in the Companion.'}).waitFor({timeout: 2_000});
  assert.equal(await fourth.count(), 1, 'a refused decision brings the item back');
  await shot('desktop-host-failed');

  // The Companion cannot be reached: the item comes back as well.
  await set(`window.companion.reply = {ok: false, reason: 'unavailable'}`);
  await armedAgain();
  await fourth.getByRole('button', {name: 'Approve'}).click();
  await line.filter({hasText: 'The Construct Companion is not reachable. ssh-key for agent-vm still waits.'}).waitFor({timeout: 2_000});
  assert.equal(await fourth.count(), 1, 'a failed decision brings the item back');
  await shot('desktop-unreachable');
  assert.deepEqual(await page.evaluate(() => window.companion.decisions),
    [['c-local', 'approve'], ['c-3', 'deny'], ['c-4', 'approve'], ['c-4', 'approve']]);

  // Nothing waits any more: the banner goes away once the result line has been read.
  await set(`window.companion.answer.approvals = []; window.fixture.answers['env-a'] = []`);
  await banner.waitFor({state: 'detached', timeout: 10_000});
  // The visible page keeps reporting that it shows none.
  assert.deepEqual(await nextReport(), []);

  // Hidden while the Companion's answer is on its way: that answer reports nothing, and
  // nothing at all while hidden; visible again, it reports at once.
  await set(`window.companion.answer.approvals = [approval('c-5', {names: ['gh-token'], title: 'Fifth request'})]`);
  await item('Fifth request').waitFor({timeout: 5_000});
  assert.deepEqual(await nextReport(), ['c-5']);
  const held = await page.evaluate(() => { window.companion.holdList = true; return window.companion.lists; });
  await page.waitForFunction((count) => window.companion.lists > count, held, {timeout: 5_000});
  const beforeHidden = await reportCount();
  await set(`window.visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))`);
  await set('window.companion.holdList = false; window.companion.releaseList()');
  await page.waitForTimeout(3_500);
  assert.equal(await reportCount(), beforeHidden, 'no report while the page is hidden');
  await set(`window.visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'))`);
  assert.deepEqual(await nextReport(), ['c-5']);

  // Closed by the user: nothing is reported while its requests wait, though the page is
  // visible; another request brings the banner and the reports back.
  await page.locator('[data-slot="toast-close"]').click();
  await banner.waitFor({state: 'detached', timeout: 5_000});
  const closed = await reportCount();
  await nextList();
  await nextList();
  assert.equal(await reportCount(), closed, 'no report while the banner is closed');
  await set(`window.companion.answer.approvals.push(approval('c-6', {names: ['pypi-token'], title: 'Sixth request'}))`);
  await item('Sixth request').waitFor({timeout: 5_000});
  assert.deepEqual((await nextReport()).toSorted(), ['c-5', 'c-6']);

  // No answer from the Companion: nothing to report.
  await set(`window.companion.answer = {available: false}`);
  await items.first().waitFor({state: 'detached', timeout: 5_000});
  const unavailable = await reportCount();
  await nextList();
  assert.equal(await reportCount(), unavailable, 'no report without the Companion');
  assert.ok((await page.evaluate(() => window.companion.reports)).every((report) => report.visibility === 'visible'),
    'every report was made while the page was visible');
  await page.close();
}
