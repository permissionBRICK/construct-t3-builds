// Run with T3_TEST_TOOLS pointing at a checkout with esbuild installed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require=createRequire(resolve(process.env.T3_TEST_TOOLS || '.', 'package.json'));
const {build}=require('esbuild');
const toastStub={name:'toast',setup(b){
 b.onResolve({filter:/\/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const toastManager={add(){}}; export const stackedThreadToast=x=>x;'}));
}};
const load=async(channel,file,plugins=[])=>{
 const result=await build({entryPoints:[`patches/t3code-${channel}/overlays/apps/web/src/components/${file}`],
  bundle:true,write:false,platform:'node',format:'esm',plugins});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const vm=name=>({name,vmHost:`${name}.mshome.net`,publicHost:null,hostAlias:name,isDefault:false,provisionedCommit:null,
 channel:'latest',t3Port:null,t3Enabled:true,t3BaseUrl:null,t3Link:null});
for(const channel of ['release','nightly']) {
 const {startConstructUpdate,setConstructLinkedRemotes,setConstructVmUpdateRunner}=await load(channel,'constructUpdate.ts',[toastStub]);
 let calls=0;
 const info={action:'reprovision',runningAction:null,vmName:'thread-vm',instances:[vm('thread-vm'),vm('stopped-vm')],
  installedCommit:'d'.repeat(40),latestCommit:'f'.repeat(40),provisionedCommit:'d'.repeat(40),
  constructUpdateAvailable:true,t3LatestVersion:null,provisionStale:true,t3LatestByChannel:{latest:null,nightly:null}};
 let hostCalls=0;
 const targets=[];
 const actions=[];
 const resultFor=action=>({accepted:true,completed:false,state:{construct:{...info,runningAction:action}}});
 const bridge={
  downloadUpdate:async()=>{hostCalls++;return resultFor(bridge.next ?? 'update-construct');},
  reprovisionConstructInstance:async (name,action)=>{calls++;targets.push(name);actions.push(action);return resultFor(action);},
 };
 assert.equal(await startConstructUpdate(bridge,info),true);
 assert.equal(calls,1,'one explicit action must launch without a second confirmation');
 assert.equal(await startConstructUpdate(bridge,{...info,runningAction:'reprovision'}),false);
 assert.equal(calls,1);
 // Nightly reprovisions every VM that is behind in one console, named; release the displayed one.
 assert.deepEqual(targets,[channel==='nightly'?['thread-vm']:'thread-vm'],'reprovision must name the VM');
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
 assert.equal(await startConstructUpdate(bridge,{...info,action:null,constructUpdateAvailable:false,latestCommit:null}),false);
 assert.equal(hostCalls,1,'no published offer must not launch a host update');
 if(channel==='nightly'){
  // The new Construct: the one Update goes to the main process (the device agent) once...
  bridge.next='update-everything';
  const everything={...info,action:'update-everything',everything:{source:'agent',version:'1.4.0',available:'1.5.0',vms:[],running:false,parts:[]}};
  assert.equal(await startConstructUpdate(bridge,everything),true);
  assert.equal(hostCalls,2);
  assert.equal(await startConstructUpdate(bridge,{...everything,runningAction:'update-everything'}),false);
  assert.equal(hostCalls,2,'a running update is not started again');
  // ...and in a browser to the VM, never to a bridge.
  let vmRuns=0;
  const page={...everything,everything:{...everything.everything,source:'vm'}};
  assert.equal(await startConstructUpdate(undefined,page),false,'no runner: nothing to start');
  setConstructVmUpdateRunner(async()=>{vmRuns++;return {started:true,message:null};});
  assert.equal(await startConstructUpdate(undefined,page),true);
  assert.equal(await startConstructUpdate(bridge,page),true);
  assert.equal(vmRuns,2);
  assert.equal(hostCalls,2,'the VM path never calls the Desktop bridge');
  setConstructVmUpdateRunner(async()=>({started:false,message:'no'}));
  assert.equal(await startConstructUpdate(undefined,page),false);
 }
 const {getConstructUpdateDetail}=await load(channel,'constructUpdate.logic.ts');
 assert.equal(getConstructUpdateDetail({...info,action:'update-construct'}),
  "A new Construct update is available. Click to install it on this PC. This doesn't interrupt your work in T3 Code.");
 console.log(`PASS ${channel}: one click launches once; reprovision and T3 Code updates name their VMs; running/no-offer actions guarded${channel==='nightly'?'; the one Update goes to the agent or the VM':''}`);
}
