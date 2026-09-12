// Run the actual inventory's voice callbacks and upstream replacement callback
// with the real Lexical composer in Chromium. Audio/STT transport is mocked.
// T3_TEST_SOURCE: matching upstream checkout; T3_TEST_TOOLS: package directory
// providing playwright. Uses the checkout's Vite for browser imports, including
// ?worker and import.meta.env. T3_TEST_CHANNEL defaults to release.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const source = process.env.T3_TEST_SOURCE;
if (!source) throw new Error('Set T3_TEST_SOURCE to the matching upstream checkout');
const toolRequire = createRequire(path.resolve(process.env.T3_TEST_TOOLS || root, 'package.json'));
const sourceRequire = createRequire(path.join(source, 'apps/web/package.json'));
const {build} = sourceRequire('vite-plus');
const {chromium} = toolRequire('playwright');
const channel = process.env.T3_TEST_CHANNEL || 'release';
const manifestPath = `patches/t3code-${channel}/source-transforms.json`;
const manifest = JSON.parse(process.env.T3_TEST_BASELINE
  ? execFileSync('git', ['show', `${process.env.T3_TEST_BASELINE}:${manifestPath}`], {cwd:root, encoding:'utf8'})
  : fs.readFileSync(path.join(root, manifestPath), 'utf8'));
const inserts = manifest.transforms.filter(t => t.path.endsWith('/ChatComposer.tsx')).map(t => t.insert || '');
const types = inserts.find(s => s.includes('type VoiceInsertionState')).split('type VoiceInsertionState')[1];
const voice = inserts.find(s => s.includes('const stopVoiceRecording = useCallback'));
const upstream = fs.readFileSync(path.join(source, 'apps/web/src/components/chat/ChatComposer.tsx'), 'utf8');
const replacement = upstream.slice(upstream.indexOf('  const applyPromptReplacement = useCallback('), upstream.indexOf('  const readComposerSnapshot = useCallback('));
const editorLock = manifest.transforms.some(t => (t.replace?.startsWith('disabled={isVoiceRecording ||')) || (t.scope === '<ComposerPromptEditor' && t.insert?.includes('isVoiceRecording ||')));
const changeGuard = inserts.find(s => s.includes('Voice owns the draft')) ?? '';
const entry = `
import React, {useState, useRef, useCallback, useEffect} from ${JSON.stringify(sourceRequire.resolve('react'))};
import {createRoot} from ${JSON.stringify(sourceRequire.resolve('react-dom/client'))};
import {ComposerPromptEditor} from ${JSON.stringify(path.join(source,"apps/web/src/components/ComposerPromptEditor.tsx"))};
type VoiceInsertionState${types}
const environmentId = 'env'; const environmentUnavailable = null; const supportsVoiceInput = true;
const voiceInputSource = {source:window.clientVoice ? 'client' : 'host'}; const composerDraftTarget = 'thread';
let nextSession = 0; const composerTargetKey = x => x; const randomUUID = () => String(++nextSession);
const AsyncResult = {isFailure: r => r.failure, isSuccess: r => !r.failure}; const toastManager = {add: x => window.toasts.push(x)};
const collapseExpandedComposerCursor = (v,c) => c; const expandCollapsedComposerCursor = (v,c) => c;
const detectComposerTrigger = () => null;
const replaceTextRange = (value,start,end,text) => ({text:value.slice(0,start)+text+value.slice(end),cursor:start+text.length});
import {createVoiceAudioSender} from ${JSON.stringify(path.join(root, `patches/t3code-${channel}/overlays/apps/web/src/voice/voiceAudioSender.ts`))};
import {recoverVoiceSubscription} from ${JSON.stringify(path.join(root, `patches/t3code-${channel}/overlays/apps/web/src/voice/voiceSessionRecovery.ts`))};
const canReconnectVoiceInput = () => true;
const startClientAudioCapture = ({onChunk}) => {
 window.capturing=true;
 window.audio=()=>{window.captured+=3200;onChunk(new Uint8Array(3200))};
 return {stop:()=>{window.capturing=false},finish:async()=>{window.capturing=false}};
};
const MAX_PENDING_VOICE_CHUNKS = 8; const describeVoiceInputFailure = () => 'failure';
function Harness() {
 const [prompt,setPrompt] = useState('chat draft stays here');
 const [pending,setPending] = useState({requestId:'request',id:'question-1',customAnswer:'answer prefix'});
 const activePendingProgress = pending && {...pending, activeQuestion:{id:pending.id}};
 const activePendingUserInput = pending;
 const promptRef = useRef(prompt);
 const [composerCursor,setComposerCursor] = useState(0);
 const setComposerTrigger = () => {};
 const composerEditorRef = useRef(null);
 const readComposerSnapshot = useCallback(() => composerEditorRef.current.readSnapshot(), []);
 const onChangeActivePendingUserInputCustomAnswer = (id,text) => {
   window.writes.push(id);
   setPending(previous => ({...previous, customAnswer:text}));
 };
 useEffect(() => {promptRef.current = activePendingProgress?.customAnswer ?? prompt}, [pending,prompt]);
 const [isVoiceRecording,setIsVoiceRecording] = useState(false);
 const [voiceLevel,setVoiceLevel] = useState(0);
 const [voiceStatus,setVoiceStatus] = useState("Recording");
 const voiceInsertionRef = useRef(null); const voiceShortcutRef = useRef(null);
 const runStartVoiceInput = ({onEvent,resume}) => {
   window.starts.push(resume);
   if(window.offline) return Promise.resolve({failure:true,cause:{}});
   window.transcript=text=>onEvent({type:'transcript',text});
   window.voiceEvent=onEvent;
   queueMicrotask(()=>onEvent({type:'listening'}));
   return new Promise(resolve=>{window.endStream=resolve;window.disconnect=()=>{window.offline=true;resolve({failure:true,cause:{}})}});
 };
 const runStopVoiceInput = useCallback(async () => {
   window.stops++;
   if(window.offline) return {failure:true};
   if (!window.holdFinal) { window.voiceEvent?.({type:'stopped',reason:'user-stop'}); window.endStream?.({failure:false}); }
   return {failure:false,value:{stopped:true}};
 }, []);
 const runSendVoiceAudio = async ({chunk,sequence}) => {
   if(window.offline) return {failure:true};
   if(sequence===window.received) window.received+=chunk.length;
   return {failure:false,value:{accepted:true,nextSequence:window.received}};
 };
 ${replacement}
 ${voice}
 window.editorSnapshot=()=>composerEditorRef.current.readSnapshot();
 window.focusEnd=()=>composerEditorRef.current.focusAtEnd();
 window.longDraft=()=>{setPending(null);setPrompt('A long existing draft. '.repeat(1000))};
 window.changeQuestion = () => setPending(p => ({...p, id:'question-2'}));
 window.leaveQuestion = () => setPending(null);
 window.staleRef = () => {promptRef.current=prompt};
 window.changeChatDraft = () => setPrompt('saved background draft');
 return React.createElement('form',{'data-chat-composer-form':'true'},
   React.createElement(ComposerPromptEditor,{editorRef:composerEditorRef,value:pending?.customAnswer ?? prompt,cursor:composerCursor,contextRecords:new Map(),terminalContexts:[],skills:[],disabled:${editorLock ? 'isVoiceRecording' : 'false'},placeholder:'Compose',onChange:(text,cursor)=>{${changeGuard}setComposerCursor(cursor);pending?setPending({...pending,customAnswer:text}):setPrompt(text)},onPaste:()=>{}}),
   React.createElement('button',{type:'button',onPointerDown:e=>e.preventDefault(),onClick:toggleVoiceRecording,'data-recording':String(isVoiceRecording)},'Mic'),
   React.createElement('output',null,prompt), React.createElement('span',{'data-status':true},voiceStatus));
}
window.holdFinal=false;window.toasts=[];window.stops=0;window.writes=[];window.starts=[];window.offline=false;window.received=0;window.captured=0;
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;
const browser = await chromium.launch({headless:true, ...(process.env.T3_TEST_CHROMIUM ? {executablePath:process.env.T3_TEST_CHROMIUM} : {})});
try {
 const entryId = path.join(source, 'apps/web/voice-question-test.tsx');
 const bundle = await build({
   configFile:false, root:path.join(source,'apps/web'), envDir:false,
   resolve:{alias:{'~':path.join(source,'apps/web/src')}},
   define:{'process.env.NODE_ENV':'"development"'},
   plugins:[{
     name:'voice-question-entry',
     resolveId(id){if(id===entryId) return entryId;},
     load(id){if(id===entryId) return entry;},
   }],
   build:{write:false, minify:false, lib:{entry:entryId, name:'VoiceQuestionTest', formats:['iife']}},
 });
 const outputs = [bundle].flat().flatMap(result=>result.output);
 const script = outputs.find(output=>output.type==='chunk' && output.isEntry);
 assert.ok(script, 'Vite produced the browser test entry');
 const page = await browser.newPage();
 await page.route('http://voice.test/**', route=>{
   const fileName = new URL(route.request().url()).pathname.slice(1);
   if(!fileName) return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
   const output = outputs.find(output=>output.fileName===fileName);
   assert.ok(output, `Unexpected browser asset request: ${fileName}`);
   return route.fulfill({contentType:fileName.endsWith('.js')?'text/javascript':'application/octet-stream',
     body:output.type==='chunk'?output.code:Buffer.from(output.source)});
 });
 page.setDefaultTimeout(2000);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message); console.error('Browser:',e.stack)});
 async function reset(client=false) {
   await page.goto('http://voice.test');
   await page.setContent('<div id="root"></div>');
   await page.evaluate(value=>{window.clientVoice=value},client);
   await page.addScriptTag({content:script.code});
   await page.locator('[contenteditable]').waitFor();
 }
 async function recording(value) { await page.waitForFunction(v=>document.querySelector('button')?.dataset.recording===String(v), value, {timeout:2000}); }
 const editor = page.locator('[contenteditable]');
 const value = () => page.evaluate(()=>window.editorSnapshot().value);
 async function textIs(text) {try {await page.waitForFunction(expected=>window.editorSnapshot().value===expected,text);} catch(error) {console.error('Editor state:',await page.evaluate(()=>({value:window.editorSnapshot().value,stops:window.stops,recording:document.querySelector('button').dataset.recording})));throw error;}}
 async function editable(enabled) {await page.waitForFunction(expected=>document.querySelector('[contenteditable]').getAttribute('contenteditable')===String(expected),enabled);}
 async function start() {await page.evaluate(()=>window.focusEnd());await page.getByText('Mic',{exact:true}).click();await recording(true);}
 async function stop() {await page.getByText('Mic',{exact:true}).click();await recording(false);await editable(true);}

 // Recording must preserve focus so Ctrl+T can stop it before the first transcript.
 await reset();await page.evaluate(()=>window.focusEnd());
 await page.keyboard.press('Control+t');await recording(true);await editable(true);
 assert.equal(await editor.evaluate(el=>document.activeElement===el),true,'starting voice keeps editor focus');
 await page.keyboard.press('Control+t');await recording(false);
 assert.equal(await page.evaluate(()=>window.stops),1);
 // A mic-button start can also be stopped by the shortcut after a transcript.
 await start();await page.evaluate(()=>window.transcript('shortcut test'));
 await textIs('answer prefix shortcut test');
 await page.keyboard.press('Control+t');await recording(false);
 assert.equal(await page.evaluate(()=>window.stops),2);
 // Holding the shortcut still stops on release.
 await page.keyboard.down('Control');await page.keyboard.down('t');await recording(true);
 await page.waitForTimeout(450);await page.keyboard.up('t');await page.keyboard.up('Control');
 await recording(false);assert.equal(await page.evaluate(()=>window.stops),3);

 // Reproduces the old false manual-edit cancellation before React/Lexical commits.
 await reset(); await start();
 await page.evaluate(()=>{window.transcript('first');window.transcript('first second');window.transcript('first second third')});
 await textIs('answer prefix first second third');
 await recording(true);await editable(true);
 assert.equal(await page.evaluate(()=>window.stops),0,'batched partials must not stop dictation');
 await stop();

 // Pending answers, unrelated draft changes and stale shared refs remain safe.
 await reset();await start();
 await page.evaluate(()=>window.changeChatDraft());
 await page.evaluate(()=>{window.staleRef();window.transcript('spoken')});
 await textIs('answer prefix spoken');
 await page.evaluate(()=>window.transcript('spoken answer'));
 await textIs('answer prefix spoken answer');await recording(true);
 assert.equal(await page.locator('output').textContent(),'saved background draft');
 assert.deepEqual(await page.evaluate(()=>window.writes),['question-1','question-1']);
 // Editing remains available and does not stop recording. Subsequent speech may overwrite it.
 await editor.fill('manual edit during recording');
 await textIs('manual edit during recording');await recording(true);
 assert.equal(await page.evaluate(()=>window.stops),0);
 await page.evaluate(()=>window.transcript('spoken answer continues'));
 await textIs('answer prefix spoken answer continues');await recording(true);
 // Editing and the Stop button remain available while the provider finishes.
 await page.evaluate(()=>{window.holdFinal=true});
 await page.getByText('Mic',{exact:true}).click();
 await page.waitForFunction(()=>window.stops===1);await editable(true);
 await page.evaluate(()=>window.transcript('spoken answer finalized'));
 await textIs('answer prefix spoken answer finalized');
 await page.evaluate(()=>{window.voiceEvent({type:'stopped',reason:'user-stop'});window.endStream({failure:false})});
 await recording(false);await editable(true);
 await editor.fill('my manual edit');await textIs('my manual edit');
 await page.evaluate(()=>window.transcript('late result'));
 assert.equal(await value(),'my manual edit');

 // A target change still cancels and rejects late transcripts.
 await reset();await start();
 await page.evaluate(()=>window.changeQuestion());await recording(false);await editable(true);
 await page.evaluate(()=>window.transcript('wrong question'));
 assert.equal(await value(),'answer prefix');
 assert.deepEqual(await page.evaluate(()=>window.writes),[]);
 await start();await page.evaluate(()=>window.leaveQuestion());await recording(false);
 await page.evaluate(()=>window.transcript('wrong target'));
 await textIs('chat draft stays here');

 // Repeated recordings into a long draft, each receiving a burst of partials.
 await reset();await page.evaluate(()=>window.longDraft());
 let expected='A long existing draft. '.repeat(1000);await textIs(expected);
 for(let iteration=0;iteration<5;iteration++) {
   await start();await editable(true);
   await page.evaluate(i=>{window.transcript('next');window.transcript('next phrase');window.transcript('next phrase '+i)},iteration);
   expected+=(expected.endsWith(' ')?'':' ')+'next phrase '+iteration;
   await textIs(expected);await recording(true);await stop();
 }
 assert.equal(await page.evaluate(()=>window.stops),5,'only explicit Stop requests');
 await editor.fill('editable again');await textIs('editable again');
 await start();await editor.fill('manual normal chat edit');
 await textIs('manual normal chat edit');await recording(true);
 await page.evaluate(()=>window.transcript('continued speech'));
 await textIs('editable again continued speech');await recording(true);await stop();


 // Unexpected stream completion and server recording limits leave editing available.
 await reset();await start();
 await page.evaluate(()=>window.endStream({failure:false}));
 await recording(false);await editable(true);
 assert.equal(await page.evaluate(()=>window.toasts[0]?.type),'error');
 await editor.fill('after failure');await textIs('after failure');
 await reset();await start();
 await page.evaluate(()=>{window.voiceEvent({type:'stopped',reason:'recording-limit'});window.endStream({failure:false})});
 await recording(false);await editable(true);
 assert.equal(await page.evaluate(()=>window.toasts[0]?.type),'info');

 // Client transport: outage keeps capture open, and Stop drains after reconnect.
 await reset(true);await start();
 await page.evaluate(()=>{window.audio();window.transcript('first words')});
 await page.waitForFunction(()=>window.received===3200);
 await page.evaluate(()=>window.disconnect());
 await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Reconnecting'));
 for(let i=0;i<40;i++) {await page.evaluate(()=>window.audio());await page.waitForTimeout(100);}
 await recording(true);await editable(true);
 assert.equal(await page.evaluate(()=>window.capturing),true);
 await page.getByText('Mic',{exact:true}).click();
 await page.waitForFunction(()=>!window.capturing);await editable(true);
 assert.equal(await page.evaluate(()=>window.stops),0,'Stop waits for queued audio');
 await page.evaluate(()=>{window.offline=false});
 await recording(false);await editable(true);
 assert.equal(await page.evaluate(()=>window.received),await page.evaluate(()=>window.captured));
 assert.equal(await value(),'answer prefix first words');
 assert.equal(await page.evaluate(()=>window.starts.slice(1).every(Boolean)),true);
 assert.deepEqual(await page.evaluate(()=>window.toasts),[]);
 assert.deepEqual(errors,[]);
 console.log('PASS: '+channel+' real editor: focus and stop shortcuts, editable capture/finalization, batched partials, repeated long drafts, target changes, late results and offline Stop');
} finally {await browser.close();}
