// The key vault banner in Chromium with React and the real T3 toast UI; only the
// servers' `construct.vaultPending` answers and the environment list are fixtures.
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
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  for (const name of css) await page.addStyleTag({path: path.join(distAssets, name)});
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
  assert.deepEqual(errors, []);
  console.log(`PASS ${channel}: vault banner links, Companion hint, list cap, visibility pause, hide and auto-clear`);
} finally {
  await browser.close();
}
