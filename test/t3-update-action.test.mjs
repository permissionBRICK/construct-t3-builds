// Run with T3_TEST_TOOLS pointing at a checkout with esbuild installed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require=createRequire(resolve(process.env.T3_TEST_TOOLS || '.', 'package.json'));
const {build}=require('esbuild');
for(const channel of ['release','nightly']) {
 const result=await build({entryPoints:[`patches/t3code-${channel}/overlays/apps/web/src/components/constructUpdate.ts`],
  bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'toast',setup(b){
   b.onResolve({filter:/\/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const toastManager={add(){}}; export const stackedThreadToast=x=>x;'}));
  }}]});
 const {startConstructUpdate,setConstructLinkedRemotes}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 let calls=0;
 const vm=name=>({name,vmHost:`${name}.mshome.net`,publicHost:null,hostAlias:name,isDefault:false,provisionedCommit:null,
  channel:'latest',t3Port:null,t3Enabled:true,t3BaseUrl:null,t3Link:null});
 const info={action:'reprovision',runningAction:null,vmName:'thread-vm',instances:[vm('thread-vm'),vm('stopped-vm')],
  installedCommit:'d'.repeat(40),latestCommit:'f'.repeat(40),provisionedCommit:'d'.repeat(40),
  constructUpdateAvailable:true,t3LatestVersion:null};
 let hostCalls=0;
 const targets=[];
 const actions=[];
 const resultFor=action=>({accepted:true,completed:false,state:{construct:{...info,runningAction:action}}});
 const bridge={
  downloadUpdate:async()=>{hostCalls++;return resultFor('update-construct');},
  reprovisionConstructInstance:async (name,action)=>{calls++;targets.push(name);actions.push(action);return resultFor(action);},
 };
 assert.equal(await startConstructUpdate(bridge,info),true);
 assert.equal(calls,1,'one explicit action must launch without a second confirmation');
 assert.equal(await startConstructUpdate(bridge,{...info,runningAction:'reprovision'}),false);
 assert.equal(calls,1);
 assert.deepEqual(targets,['thread-vm'],'reprovision must name the displayed thread VM');
 assert.equal(hostCalls,0,'reprovision must not use the host/default-VM launch');
 assert.deepEqual(actions,['reprovision'],'a reprovision must say so');
 assert.equal(await startConstructUpdate(bridge,{...info,action:'update-t3'}),false);
 assert.equal(calls,1,'a T3 Code update without a connected VM must not launch');
 setConstructLinkedRemotes([
  {id:'env-thread',baseUrl:'https://thread-vm.mshome.net:5178',connected:true},
  {id:'env-stopped',baseUrl:'https://stopped-vm.mshome.net:5178',connected:false},
 ]);
 assert.equal(await startConstructUpdate(bridge,{...info,action:'update-t3'}),true);
 assert.deepEqual([targets[1],actions[1]],[['thread-vm'],'update-t3'],'a T3 Code update must name the connected VMs and the action');
 assert.equal(hostCalls,0,'a T3 Code update must not use the host/default-VM launch');
 calls=1;
 assert.equal(await startConstructUpdate(bridge,{...info,action:'update-construct'}),true);
 assert.equal(hostCalls,1);
 assert.equal(calls,1);
 const presentation=await build({entryPoints:[`patches/t3code-${channel}/overlays/apps/web/src/components/constructUpdate.logic.ts`],
  bundle:true,write:false,platform:'node',format:'esm'});
 const {getConstructUpdateDetail,getConstructUpdateNotificationKey}=await import(
  'data:text/javascript;base64,'+Buffer.from(presentation.outputFiles[0].text).toString('base64'));
 const hostInfo={...info,action:'update-construct'};
 assert.equal(getConstructUpdateDetail(hostInfo),
  "A new Construct update is available. Click to install it on this PC. This doesn't interrupt your work in T3 Code.");
 assert.equal(getConstructUpdateNotificationKey(hostInfo),
  getConstructUpdateNotificationKey({...hostInfo,latestCommit:'e'.repeat(40)}));
 assert.equal(await startConstructUpdate(bridge,{...info,action:null,constructUpdateAvailable:false,latestCommit:null}),false);
 assert.equal(hostCalls,1,'no published offer must not launch a host update');
 console.log(`PASS ${channel}: one click launches once; T3 Code updates target the connected VMs; running/no-offer actions guarded; manifest detail and notification identity`);
}
