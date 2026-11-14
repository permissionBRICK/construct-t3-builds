// T3's own update control at the bottom of the sidebar, in Chromium with React, showing and
// starting Construct's update: in the Desktop app with a device agent (the one Update), in
// the Desktop app without one (the old Construct's scripts), and in a browser without the
// Desktop app (the VM's own update). The control is upstream's SidebarUpdatePill from the
// patched checkout; desktop IPC, the environments and the RPC commands are fixtures.
// T3_TEST_SOURCE: the patched upstream checkout with installed dependencies (nightly).
// T3_TEST_TOOLS: a package directory providing esbuild + playwright.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const source = process.env.T3_TEST_SOURCE;
if (!source) throw new Error('Set T3_TEST_SOURCE');
const toolRequire = createRequire(resolve(process.env.T3_TEST_TOOLS || '.', 'package.json'));
const {build} = toolRequire('esbuild');
const {chromium} = toolRequire('playwright');
const viteSuffixStubs = {name:'vite-suffix-stubs',setup(b){
  b.onResolve({filter:/\?(worker|url|raw|inline)$/},args=>({path:args.path,namespace:'vite-suffix'}));
  b.onLoad({filter:/.*/,namespace:'vite-suffix'},()=>({contents:'export default "";'}));
}};
const env = 'export const isElectron=window.isElectron===true;';
const toast = `export const stackedThreadToast=x=>x; export const toastManager={add(x){window.toasts.push(x);return window.toasts.length;},close(){},update(){}};`;
const mocks = {
  '../../env': env, '../env': env,
  '../ui/toast': toast, './ui/toast': toast,
  '../../hooks/useMediaQuery': 'export const useMediaQuery=()=>true;',
  '../../localApi': 'export const ensureLocalApi=()=>({dialogs:{confirm:async()=>true}});',
  '../../state/desktopUpdate': 'export const useDesktopUpdateState=()=>window.updateState;',
  '../../state/managedPolicy': 'export const usePrimaryManagedPolicy=()=>undefined;',
  '../ProviderUpdatesAction': 'export const useCheckProviderUpdates=()=>async()=>[];',
  './UpdateEverythingDialog': 'export const UpdateEverythingDialog=()=>null;',
  './SidebarUpdateCapsule': 'export const SidebarUpdateCapsule=()=>null;',
  './updateEverythingRun': 'export const useUpdateEverythingRun=()=>null; export const saveUpdateEverythingResult=()=>{}; export const clearSavedUpdateEverythingResult=()=>{};',
  './useUpdateEverything': 'export const useUpdateEverything=()=>({hasUpdates:false,summary:"",version:null,providerCount:0,rows:[],restarts:[],run:async()=>{}});',
  '../ui/sidebar': 'import {createElement} from "react"; export const SidebarMenuItem=({children})=>createElement("div",null,children);',
  '@t3tools/client-runtime/state/runtime': 'export const settlePromise=async f=>({_tag:"Success",value:await f()}); export const squashAtomCommandFailure=x=>x;',
  '../state/environments': 'export const useEnvironments=()=>({environments:window.environments}); export const usePrimaryEnvironmentId=()=>window.primary;',
  '../state/entities': 'export const useServerConfigs=()=>window.serverConfigs;',
  '../state/use-atom-command': 'export const useAtomCommand=command=>value=>window.commands[command.label](value);',
  '../state/constructVmUpdate': 'export const readConstructVmUpdate={label:"read"}; export const runConstructVmUpdate={label:"run"};',
  '../branding': 'export const APP_VERSION="0.1.10-nightly.20261113.4656";',
};
const result = await build({
  stdin: {contents: `import {createRoot} from 'react-dom/client';
    import {SidebarUpdatePill} from ${JSON.stringify(resolve(source, 'apps/web/src/components/sidebar/SidebarUpdatePill.tsx'))};
    const root=createRoot(document.getElementById('root'));
    window.render=()=>root.render(<SidebarUpdatePill />);`, loader:'tsx', resolveDir:resolve(source, 'apps/web')},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'},
  plugins:[viteSuffixStubs,{name:'fixtures',setup(b){
    b.onResolve({filter:/.*/}, args=>mocks[args.path] ? {path:args.path,namespace:'fixture'} : undefined);
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:resolve(source,'apps/web')}));
  }}],
});
const bundle = result.outputFiles[0].text;
const baseState = {enabled:true,status:'up-to-date',channel:'latest',currentVersion:'0.1.10-construct.abcdef12',hostArch:'x64',appArch:'x64',
  runningUnderArm64Translation:false,availableVersion:null,downloadedVersion:null,releaseNotes:[],omittedReleaseCount:0,downloadPercent:null,
  checkedAt:null,message:null,errorContext:null,canRetry:false};
const vm = (name,port,provisionedCommit) => ({name,vmHost:`${name}.mshome.net`,publicHost:null,hostAlias:name,isDefault:name==='agent-vm',
  provisionedCommit,channel:'latest',t3Port:port,t3Enabled:true,t3BaseUrl:null,t3Link:null});
const info = over => ({companionInstalled:true,repo:'permissionBRICK/The-Construct',ref:'main',scriptsDir:'C:\\x',vmName:'agent-vm',vmHost:'agent-vm.mshome.net',
  instances:[],installedCommit:'d'.repeat(40),provisionedCommit:'d'.repeat(40),latestCommit:'d'.repeat(40),constructUpdateAvailable:false,provisionStale:false,
  desktopVersion:'0.1.10-construct.abcdef12',t3Version:'0.1.10',t3LatestVersion:null,t3UpdateAvailable:false,t3LatestByChannel:{latest:null,nightly:null},
  action:null,runningAction:null,checkedAt:null,error:null,...over});
const agentView = over => ({source:'agent',version:'1.4.0',available:'1.5.0',vms:[],running:false,parts:[],...over});

const browser = await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.T3_TEST_CHROMIUM ? {executablePath:process.env.T3_TEST_CHROMIUM} : {})});
try {
  const open = async fixture => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    page.errors = errors;
    // A real origin: upstream modules read localStorage when they load.
    await page.route('http://construct.test/', route => route.fulfill({contentType:'text/html', body:'<div id="root"></div>'}));
    await page.goto('http://construct.test/');
    await page.evaluate(fixture => {
      Object.assign(window, {toasts:[],calls:[],environments:[],primary:null,serverConfigs:new Map(),commands:{}}, fixture.globals);
      window.updateState = fixture.updateState;
      if (fixture.desktop) window.desktopBridge = {
        // As the main process does: the launch is broadcast as running at once, and the
        // control re-renders with it before the call answers.
        downloadUpdate: async () => { window.calls.push(['downloadUpdate']);
          window.updateState = {...window.updateState,status:'downloading',construct:{...window.updateState.construct,runningAction:window.updateState.construct.action}};
          window.render(); await new Promise(r=>setTimeout(r,50));
          return {accepted:true,completed:false,state:window.updateState}; },
        reprovisionConstructInstance: async (names, action) => { window.calls.push(['reprovision', names, action]);
          return {accepted:true,completed:false,state:{...window.updateState,construct:{...window.updateState.construct,runningAction:action}}}; },
        checkForUpdate: async () => { window.calls.push(['check']); return {checked:true,state:window.updateState}; },
        getSystemLocale: () => 'en-US',
      };
    }, fixture);
    if (fixture.vm) await page.evaluate(vm => {
      window.primary = 'env-primary';
      window.serverConfigs = new Map([['env-primary', {environment:{capabilities:{constructVmUpdate:true}}}]]);
      window.commands = {
        read: async () => ({_tag:'Success', value: window.vmStatus}),
        run: async () => { window.calls.push(['vm-run']); window.vmStatus = {...window.vmStatus, running:true}; return {_tag:'Success', value:{started:true,message:null}}; },
      };
      window.vmStatus = vm;
    }, fixture.vm);
    await page.addScriptTag({content:bundle});
    assert.deepEqual(errors.map((error) => error.stack ?? String(error)), [], 'the bundle loads');
    await page.evaluate(() => window.render());
    await page.waitForTimeout(80);
    assert.deepEqual(errors.map(String), []);
    return page;
  };
  const button = page => page.locator('button[aria-label]').first();
  const label = async page => (await button(page).count()) === 0 ? null : button(page).getAttribute('aria-label');
  const calls = page => page.evaluate(() => window.calls);

  // Desktop with an agent: the new version and Update; one click starts it once, in the background.
  let page = await open({globals:{isElectron:true},desktop:true,updateState:{...baseState,status:'available',availableVersion:'Construct 1.5.0',
    construct:info({scriptsDir:null,ref:'1.4.0',action:'update-everything',everything:agentView()})}});
  assert.equal(await label(page), 'Construct 1.5.0 available — click to update everything of yours in the background.');
  await button(page).click(); await button(page).click({force:true});
  await page.waitForTimeout(120);
  assert.deepEqual(await calls(page), [['downloadUpdate']], 'one click starts it once; nothing asks a question');
  assert.equal(await label(page), 'Construct update running…');
  await page.close();

  // ...running: shown as running and inert; failed: the failure; done: nothing to offer.
  page = await open({globals:{isElectron:true},desktop:true,updateState:{...baseState,status:'downloading',availableVersion:'Construct 1.5.0',
    construct:info({scriptsDir:null,action:'update-everything',runningAction:'update-everything',everything:agentView({running:true})})}});
  assert.equal(await label(page), 'Construct update running…');
  assert.equal(await button(page).getAttribute('aria-disabled'), 'true');
  await button(page).click({force:true});
  assert.deepEqual(await calls(page), []);
  await page.close();
  page = await open({globals:{isElectron:true},desktop:true,updateState:{...baseState,status:'error',message:'home-host: the host update failed',
    errorContext:'check',canRetry:true,construct:info({scriptsDir:null,error:'home-host: the host update failed',everything:agentView({available:null})})}});
  assert.match(await label(page), /home-host: the host update failed/);
  await page.close();
  page = await open({globals:{isElectron:true},desktop:true,updateState:{...baseState,construct:info({scriptsDir:null,everything:agentView({available:null})})}});
  assert.equal(await label(page), 'Check for Construct and T3 Code updates');
  await button(page).click();
  assert.deepEqual(await calls(page), [['check']], 'up to date: the click checks, it starts nothing');
  await page.close();

  // Desktop without an agent: the same control drives the scripts; a linked VM that is behind
  // is reprovisioned by name, even when the default VM is current.
  page = await open({globals:{isElectron:true,environments:[{environmentId:'env-dev',label:'dev',displayUrl:'https://dev.mshome.net:5179',
      entry:{target:{_tag:'BearerConnectionTarget'}},connection:{phase:'connected'}}]},
    desktop:true,updateState:{...baseState,construct:info({instances:[vm('agent-vm',5178,'d'.repeat(40)),vm('dev',5179,'b'.repeat(40))]})}});
  assert.match(await label(page), /^VM reprovision pending/);
  await button(page).click();
  await page.waitForTimeout(50);
  assert.deepEqual(await calls(page), [['reprovision',['dev'],'reprovision']]);
  await page.close();

  // A browser without the Desktop app: the VM's own update, started once through the VM.
  page = await open({globals:{isElectron:false},updateState:null,vm:{available:true,running:false,version:'2.1.0',host:true,appliedCommit:'0123456'}});
  assert.equal(await label(page), 'Construct 2.1.0 available — click to update everything of yours in the background.');
  await button(page).click(); await button(page).click({force:true});
  await page.waitForTimeout(80);
  assert.deepEqual(await calls(page), [['vm-run']]);
  await page.close();
  // ...nothing to show: no control at all, as upstream renders none in a browser.
  page = await open({globals:{isElectron:false},updateState:null,vm:{available:false,running:false,version:null,host:false,appliedCommit:'0123456'}});
  assert.equal(await label(page), null);
  await page.close();
  console.log('PASS nightly: the sidebar update control shows and starts Construct updates (agent, scripts, VM; available, running, failed, done)');
} finally { await browser.close(); }
