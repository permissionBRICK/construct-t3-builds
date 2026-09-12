// Actual popup in Chromium with React; router/catalog/desktop IPC are fixtures.
// T3_TEST_SOURCE supplies installed upstream web dependencies and route helpers.
// T3_TEST_TOOLS supplies esbuild + playwright; T3_TEST_CHANNEL is release or nightly.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const source = process.env.T3_TEST_SOURCE;
if (!source) throw new Error('Set T3_TEST_SOURCE');
const toolRequire = createRequire(resolve(process.env.T3_TEST_TOOLS || '.', 'package.json'));
const sourceRequire = createRequire(resolve(source, 'apps/web/package.json'));
const {build} = toolRequire('esbuild');
// Vite-only import suffixes (`?worker`, `?url`, `?raw`, `?inline`) mean nothing to esbuild; the
// upstream web app uses them for modules this test never exercises, so they become inert stubs.
const viteSuffixStubs = {name:'vite-suffix-stubs',setup(b){
  b.onResolve({filter:/\?(worker|url|raw|inline)$/},args=>({path:args.path,namespace:'vite-suffix'}));
  b.onLoad({filter:/.*/,namespace:'vite-suffix'},args=>({contents:/\?worker$/.test(args.path)
    ? 'export default class { postMessage(){} terminate(){} addEventListener(){} removeEventListener(){} }'
    : 'export default "";'}));
}};
const {chromium} = toolRequire('playwright');
const channel = process.env.T3_TEST_CHANNEL || 'release';
const mocks = {
  '@tanstack/react-router': 'export const useNavigate=()=>()=>{}; export const useParams=({select})=>select(window.params);',
  '../composerDraftStore': 'export const useComposerDraftStore=select=>select({getDraftSession:()=>window.draft});',
  '../env': 'export const isElectron=true;',
  '../state/environments': 'export const useEnvironments=()=>({environments:window.environments});',
  '../state/desktopUpdate': 'export const useDesktopUpdateState=()=>window.updateState;',
  '../providerUpdateDismissal': 'export const useDismissedProviderUpdateNotificationKeys=()=>({dismissedNotificationKeys:window.dismissed,dismissNotificationKey:key=>window.dismissed.add(key)});',
  './ui/toast': `export const stackedThreadToast=x=>x; export const toastManager={
    add(x){const id=++window.nextToast;window.toasts.set(id,x);return id;},
    close(id){window.toasts.delete(id);}
  };`,
};
const result = await build({
  stdin: {contents: `import {createRoot} from 'react-dom/client';
    import {ConstructUpdateNotification} from ${JSON.stringify(resolve(`patches/t3code-${channel}/overlays/apps/web/src/components/ConstructUpdateNotification.tsx`))};
    const root=createRoot(document.getElementById('root'));
    window.render=()=>root.render(<ConstructUpdateNotification />);`, loader:'tsx', resolveDir:process.cwd()},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
  // Upstream reads import.meta.env at module load (cloud/publicConfig.ts); an iife bundle has none.
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'},
  plugins:[viteSuffixStubs,{name:'fixtures',setup(b){
    b.onResolve({filter:/.*/}, args=>{
      if(mocks[args.path]) return {path:args.path,namespace:'fixture'};
      if(args.path==='../threadRoutes') return {path:resolve(source,'apps/web/src/threadRoutes.ts')};
      if(/^react(?:-dom)?(?:\/|$)/.test(args.path)) return {path:sourceRequire.resolve(args.path)};
    });
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path]}));
  }}],
});
const browser = await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.T3_TEST_CHROMIUM ? {executablePath:process.env.T3_TEST_CHROMIUM} : {})});
try {
 const page = await browser.newPage();
 await page.setContent('<div id="root"></div>');
 await page.evaluate(()=>{
   window.nextToast=0;window.toasts=new Map();window.dismissed=new Set();window.launches=[];
   const instance=(name,port)=>({name,vmHost:'host.example',publicHost:'host.example',hostAlias:name,
     isDefault:name==='offline-default',provisionedCommit:'old',channel:'latest',t3Port:port,t3Enabled:true,t3BaseUrl:null,t3Link:null});
   window.updateState={enabled:true,construct:{vmName:'offline-default',vmHost:'host.example',
     instances:[instance('offline-default',2301),instance('thread-vm',2302),instance('other-vm',2303),instance('stopped-vm',2304)],
     installedCommit:'new',provisionedCommit:'old',action:'reprovision',runningAction:null,
     t3LatestByChannel:{latest:null,nightly:null},t3Version:'0.0.39',error:null}};
   window.environments=[2,3,4].map(i=>({environmentId:`env${i}`,label:`env${i}`,displayUrl:`https://host.example:230${i}`,entry:{target:{_tag:'BearerConnectionTarget'}},connection:{phase:i===4?'offline':'connected',error:null,traceId:null}}));
   window.params={environmentId:'env2',threadId:'thread'};
   window.desktopBridge={
     downloadUpdate:async()=>{throw new Error('Unexpected default-VM launch');},
     reprovisionConstructInstance:async name=>{window.launches.push(name);return {accepted:true,state:{construct:{runningAction:'reprovision'}}};},
   };
 });
 await page.addScriptTag({content:result.outputFiles[0].text});
 const render = async () => {await page.evaluate(()=>window.render());await page.evaluate(()=>new Promise(r=>setTimeout(r,30)));};
 const offers = () => page.evaluate(()=>[...window.toasts.values()].filter(x=>x.actionProps).map(x=>({label:x.actionProps.children,detail:x.description})));
 await render();
 assert.deepEqual((await offers()).map(x=>x.label),['Reprovision thread-vm']);
 assert.match((await offers())[0].detail,/"thread-vm"/);
 await page.evaluate(()=>{window.oldClick=[...window.toasts.values()][0].actionProps.onClick;window.params={environmentId:'env3',threadId:'thread'};});
 await render();
 assert.deepEqual((await offers()).map(x=>x.label),['Reprovision other-vm']);
 // A remote the app is not connected to (its VM is not running) gets no reprovision offer.
 await page.evaluate(()=>{window.params={environmentId:'env4',threadId:'thread'};});
 await render();
 assert.deepEqual((await offers()).map(x=>x.label),[]);
 await page.evaluate(()=>{window.params={environmentId:'env3',threadId:'thread'};});
 await render();
 await page.evaluate(()=>window.oldClick());
 assert.deepEqual(await page.evaluate(()=>window.launches),[],'stale toast click cannot launch a different VM');
 await page.evaluate(()=>{window.params={environmentId:'env2',threadId:'thread'};});
 await render();
 assert.deepEqual((await offers()).map(x=>x.label),['Reprovision thread-vm'],'switching back restores an offer not dismissed by the user');
 await page.evaluate(()=>{window.params={environmentId:'unknown',threadId:'thread'};});
 await render();
 assert.deepEqual(await offers(),[],'unknown thread must not target the default');
 await page.evaluate(()=>{window.params={};});
 await render();
 assert.deepEqual(await offers(),[],'no thread must not target the default');
 await page.evaluate(()=>{window.params={draftId:'draft'};window.draft={promotedTo:{environmentId:'env2',threadId:'thread'}};});
 await render();
 assert.deepEqual((await offers()).map(x=>x.label),['Reprovision thread-vm']);
 await page.evaluate(()=>[...window.toasts.values()].find(x=>x.actionProps).actionProps.onClick());
 assert.deepEqual(await page.evaluate(()=>window.launches),['thread-vm']);
 console.log(`PASS ${channel}: popup names and launches the thread VM; navigation, stale clicks, missing matches and promoted drafts`);
} finally {await browser.close();}
