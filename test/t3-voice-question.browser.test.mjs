// Run Construct's voice input hook through the patched composer's own wiring (its hook
// call, submit interception and control placements), with the real question panel,
// answer callbacks and composer editor in Chromium. Only audio/STT transport, the
// stores and toasts are mocked.
// T3_TEST_SOURCE: the matching upstream checkout with this inventory applied;
// T3_TEST_TOOLS: package directory providing playwright. Uses the checkout's Vite
// for browser imports, including ?worker and import.meta.env. T3_TEST_CHANNEL
// defaults to release.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const source = process.env.T3_TEST_SOURCE;
if (!source) throw new Error('Set T3_TEST_SOURCE to the matching patched upstream checkout');
const toolRequire = createRequire(path.resolve(process.env.T3_TEST_TOOLS || root, 'package.json'));
const sourceRequire = createRequire(path.join(source, 'apps/web/package.json'));
const {build} = sourceRequire('vite-plus');
const {chromium} = toolRequire('playwright');
const channel = process.env.T3_TEST_CHANNEL || 'release';
const manifest = JSON.parse(fs.readFileSync(path.join(root, `patches/t3code-${channel}/source-transforms.json`), 'utf8'));
const composerTransforms = manifest.transforms.filter(t => t.path === 'apps/web/src/components/chat/ChatComposer.tsx');
const transform = (description, match) => {
  const found = composerTransforms.filter(match);
  assert.equal(found.length, 1, `one ChatComposer transform ${description}`);
  return found[0].insert;
};
const hookCall = transform('calls the voice hook', t => t.insert?.includes('useConstructVoiceInput('));
const interception = transform('intercepts the submit', t => t.insert?.includes('.interceptSubmit('));
const footerControl = transform('places the footer control', t => t.insert?.includes('.footerControl'));
const questionControl = transform('places the question control', t => t.insert?.includes('.questionControl'));
const composer = fs.readFileSync(path.join(source, 'apps/web/src/components/chat/ChatComposer.tsx'), 'utf8');
const slice = (file, from, to) => {
  const start = file.indexOf(from), end = file.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `upstream still has ${JSON.stringify(from)} before ${JSON.stringify(to)}`);
  return file.slice(start, end);
};
// The hook call and the patched submitComposer, exactly as the inventory applied them.
const submit = slice(composer, hookCall, '  const submitCitationAndSend = () => {');
assert.ok(submit.includes(interception), 'the checkout carries this inventory: run bin/apply-t3code-source.mjs apply first');
const commandKey = slice(composer, '  const onComposerCommandKey = (', '  const stashQueue = usePromptStashStore(');
const replacement = slice(composer, '  const applyPromptReplacement = (', '  const readComposerSnapshot = (');
const pendingRequests = fs.readFileSync(path.join(source, 'apps/web/src/components/chat/usePendingThreadRequests.ts'), 'utf8');
const answerChange = slice(pendingRequests, '  const writePrompt = useStableCallback(', '  const onAdvanceActivePendingUserInput = () => {');
const answerSetter = slice(pendingRequests, 'function makePendingCustomAnswerSetter(', '\n}\n') + '\n}\n';
assert.ok(answerChange.includes('setPendingUserInputAnswersByRequestId'), 'exercise the real parent answer callback');
const overlayWeb = path.join(root, `patches/t3code-${channel}/overlays/apps/web`);
const sourceWeb = path.join(source, 'apps/web');
const hookFile = path.join(overlayWeb, 'src/voice/useConstructVoiceInput.tsx');
// What the hook imports from upstream's stores and the Construct transport overlays.
const hookMocks = {
  '../state/voiceInput': `export const startVoiceInput = {label:'start'}; export const stopVoiceInput = {label:'stop'}; export const sendVoiceAudio = {label:'audio'};`,
  '../state/use-atom-command': `export const useAtomCommand = command => window.voiceCommands[command.label];`,
  '../state/entities': `const configs = new Map([['env',{environment:{capabilities:{voiceInput:true,voiceInputClientAudio:true}}}]]); export const useServerConfigs = () => configs;`,
  '../hooks/useSettings': `export const useClientSettings = select => select({voiceInputSource: window.clientVoice ? 'client' : 'host'});`,
  '../components/ui/toast': `export const toastManager = {add: toast => window.toasts.push(toast)};`,
  './clientAudioCapture': `export {resolveVoiceInputSource} from ${JSON.stringify(path.join(overlayWeb, 'src/voice/clientAudioCapture.ts'))};
export const canCaptureClientAudio = () => true; export const isSecureContext = () => true;
export const startClientAudioCapture = ({onChunk}) => {
 window.capturing=true;
 window.audio=()=>{window.captured+=3200;onChunk(new Uint8Array(3200))};
 return {stop:()=>{window.capturing=false},finish:async()=>{window.capturing=false}};
};`,
};
const entry = `
import React, {useState, useRef, useCallback, useEffect, useMemo} from ${JSON.stringify(sourceRequire.resolve('react'))};
import {createRoot} from ${JSON.stringify(sourceRequire.resolve('react-dom/client'))};
import {AsyncResult} from 'effect/reactivity';
import {ComposerPromptEditor} from ${JSON.stringify(path.join(source,"apps/web/src/components/ComposerPromptEditor.tsx"))};
import {ComposerPendingUserInputPanel} from ${JSON.stringify(path.join(source,'apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx'))};
import {derivePendingUserInputProgress, buildPendingUserInputAnswers, setPendingUserInputCustomAnswer, togglePendingUserInputOptionSelection} from ${JSON.stringify(path.join(source,'apps/web/src/pendingUserInput.ts'))};
import {useStableCallback} from ${JSON.stringify(path.join(source,'apps/web/src/hooks/useStableCallback.ts'))};
import {submitComposerDraft} from ${JSON.stringify(path.join(source,'apps/web/src/components/chat/composerSubmission.ts'))};
import {composerSubmissionIntentForKey} from ${JSON.stringify(path.join(source,'apps/web/src/composer-logic.ts'))};
import {resolveComposerDispatchMode} from '@t3tools/client-runtime/state/composer-dispatch';
import {DEFAULT_RESOLVED_KEYBINDINGS} from '@t3tools/shared/keybindings';
import {useConstructVoiceInput} from ${JSON.stringify(hookFile)};
${answerSetter}
const isConnecting = false; const environmentId = 'env'; const environmentUnavailable = null;
const toastManager = {add: x => window.toasts.push(x)};
const collapseExpandedComposerCursor = (v,c) => c; const expandCollapsedComposerCursor = (v,c) => c;
const detectComposerTrigger = () => null;
const replaceTextRange = (value,start,end,text) => ({text:value.slice(0,start)+text+value.slice(end),cursor:start+text.length});
// A dropped connection fails the RPC the way the client runtime does; the hook retries those.
const offline = () => AsyncResult.fail({_tag:'RpcClientError', message:'offline'});
window.voiceCommands = {
 start: ({onEvent,resume}) => {
   window.starts.push(resume);
   if(window.offline) return Promise.resolve(offline());
   window.transcript=text=>onEvent({type:'transcript',text});
   window.voiceEvent=onEvent;
   if(!window.deferListening) queueMicrotask(()=>onEvent({type:'listening'}));
   return new Promise(resolve=>{window.endStream=()=>resolve(AsyncResult.success(undefined));window.disconnect=()=>{window.offline=true;resolve(offline())}});
 },
 stop: async () => {
   window.stops++;
   if(window.offline) return offline();
   if (!window.holdFinal) { window.voiceEvent?.({type:'stopped',reason:'user-stop'}); window.endStream?.(); }
   return AsyncResult.success({stopped:true});
 },
 audio: async ({chunk,sequence}) => {
   if(window.offline) return offline();
   if(sequence===window.received) window.received+=chunk.length;
   return AsyncResult.success({accepted:true,nextSequence:window.received});
 },
};
function Harness() {
 const [prompt,setPrompt] = useState('chat draft stays here');
 const [pending,setPending] = useState({requestId:'request',id:'question-1',customAnswer:'answer prefix',options:[],allowCustomAnswer:true});
 const [activePendingIsResponding,setResponding] = useState(false);
 const [isComposerApprovalState,setApproval] = useState(false);
 const [layout,setLayout] = useState('desktop');
 const questions = pending ? [{...pending,header:'Question',question:'How should we proceed?'}] : [];
 const answers = pending ? {[pending.id]:{customAnswer:pending.customAnswer,selectedOptionValues:pending.selectedOptionValues}} : {};
 const activePendingUserInput = pending && {...pending,questions};
 const activePendingProgress = pending && derivePendingUserInputProgress(questions,answers,0);
 const isChoiceOnlyPendingQuestion = activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
 const composerDraftTargetKey = 'thread';
 const promptRef = useRef(prompt);
 const [composerCursor,setComposerCursor] = useState(0);
 const setComposerTrigger = () => {};
 const isLiteralPendingAnswer = false; const onTypingGuardDraftChange = () => {};
 const composerEditorRef = useRef(null);
 const readComposerSnapshot = () => window.snapshotOverride ?? composerEditorRef.current.readSnapshot();
 const readComposerSnapshotStable = useStableCallback(readComposerSnapshot);
 const activePendingRequestKey = pending?.requestId ?? 'request';
 const composerRef = composerEditorRef;
 const setPendingUserInputAnswersByRequestId = update => setPending(previous => {
   const next = update({[previous.requestId]:{[previous.id]:{customAnswer:previous.customAnswer,selectedOptionValues:previous.selectedOptionValues}}});
   return {...previous,...next[previous.requestId][previous.id],selectedOptionValues:next[previous.requestId][previous.id].selectedOptionValues};
 });
 ${answerChange}

 useEffect(() => {promptRef.current = activePendingProgress?.customAnswer ?? prompt}, [pending,prompt]);
 ${replacement}
 const activeThreadId = 'thread'; const attachmentTargetKey = 'thread';
 const pendingImageCompressionsRef = useRef(new Map()); const pendingDraftWork = new Set();
 const providerInputRejectedRef = useRef(false);
 const [noProviderAvailable,setNoProviderAvailable] = useState(false);
 const isSendDisabled = !(activePendingProgress?.customAnswer ?? prompt).trim();
 const setComposerSubmissionError = () => {};
 const shouldBlurMobileComposerOnSubmit = () => false; const blurMobileComposerAfterSend = () => {};
 const onSend = (event,_dispatchMode,intent) => {
   event?.preventDefault();
   window.sends.push({text:pending?.customAnswer ?? prompt, snapshot:composerEditorRef.current.readSnapshot().value,
     answers:pending ? buildPendingUserInputAnswers(questions,answers) : null, intent});
 };
 const planModeUiEnabled = false; const isSoftwareKeyboardOpen = layout === 'mobile';
 const phase = 'idle'; const isCompacting = false; const settings = {sendShortcut:'enter',followUpBehavior:'queue'}; const followUpBehavior = settings.followUpBehavior; const keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
 const readEnvironmentScope = () => true; const AuthOrchestrationOperateScope = 'orchestration:operate'; const onTypingGuardSend = () => {};
 ${submit}
 const listContinuationForEnter = () => null; const listIndentForTab = () => null;
 const routeKind = 'draft'; const composerMenuOpenRef = useRef(false);
 const resolveActiveComposerTrigger = () => ({trigger:null});
 const navigatePromptHistory = () => false;
 ${commandKey}
 window.setNoProviderAvailable=setNoProviderAvailable;
 window.editorSnapshot=()=>composerEditorRef.current.readSnapshot();
 window.focusEnd=()=>composerEditorRef.current.focusAtEnd();
 window.focusAt=cursor=>composerEditorRef.current.focusAt(cursor);
 window.configureQuestion=config=>setPending(p=>({...p,...config}));
 window.setLayout=setLayout;
 window.setResponding=setResponding;
 window.setApproval=setApproval;
 window.answer=()=>buildPendingUserInputAnswers(questions,answers);
 window.pendingText=()=>pending?.customAnswer;
 window.longDraft=()=>{setPending(null);setPrompt('A long existing draft. '.repeat(1000))};
 window.changeQuestion = () => setPending(p => ({...p, id:'question-2'}));
 window.leaveQuestion = () => setPending(null);
 window.staleRef = () => {promptRef.current=prompt};
 window.changeChatDraft = () => setPrompt('saved background draft');
 return <form data-chat-composer-form="true" onSubmit={submitComposer}>
   <ComposerPendingUserInputPanel pendingUserInputs={pending?[activePendingUserInput]:[]}
     respondingRequestIds={activePendingIsResponding?[pending.requestId]:[]} answers={answers} questionIndex={0}
     onToggleOption={(id,value)=>setPending(p=>({...p,...togglePendingUserInputOptionSelection(questions[0],answers[id],value)}))}
     onAdvance={()=>{window.submitted=buildPendingUserInputAnswers(questions,answers)}} onDismiss={()=>setPending(null)} />
   <div style={{display:layout==='collapsed'?'none':undefined}}>
     <ComposerPromptEditor editorRef={composerEditorRef} value={pending?.customAnswer ?? prompt} cursor={composerCursor}
       contextRecords={new Map()} terminalContexts={[]} skills={[]} disabled={isChoiceOnlyPendingQuestion || activePendingIsResponding}
       placeholder="Compose" onCommandKeyDown={onComposerCommandKey} onChange={(text,cursor)=>{setComposerCursor(cursor);pending?setPending(p=>({...p,customAnswer:text})):setPrompt(text)}} onPaste={()=>{}} />
   </div>
   ${questionControl}
   <div data-chat-composer-footer="true" style={{display:layout==='desktop'?'flex':'none'}}>
     ${footerControl}
   </div>
   <output>{prompt}</output>
 </form>;
}
// The pressed state of the mic is the hook's recording state.
window.recording=()=>document.querySelector('button[aria-pressed="true"][aria-label="Stop voice input"]')!==null;
window.holdFinal=false;window.deferListening=false;window.toasts=[];window.stops=0;window.starts=[];window.sends=[];window.offline=false;window.received=0;window.captured=0;
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;
const browser = await chromium.launch({headless:true, ...(process.env.T3_TEST_CHROMIUM ? {executablePath:process.env.T3_TEST_CHROMIUM} : {})});
try {
 const entryId = path.join(source, 'apps/web/voice-question-test.tsx');
 const bundle = await build({
   configFile:false, root:sourceWeb, envDir:false,
   resolve:{alias:{'~':path.join(sourceWeb,'src')}},
   define:{'process.env.NODE_ENV':'"development"'},
   plugins:[{
     name:'voice-question-entry',
     // Ahead of Vite's resolver, which would find the transport overlays next to the hook.
     enforce:'pre',
     async resolveId(id, importer){
       if(id===entryId) return entryId;
       if(importer===hookFile && Object.hasOwn(hookMocks, id)) return '\0voice-mock:'+id;
       // Overlay files resolve upstream modules and packages from the checkout they are applied to.
       if(importer?.startsWith(overlayWeb+path.sep)) {
         const local = path.resolve(path.dirname(importer), id);
         if(id.startsWith('.') && ['.ts','.tsx'].some(ext=>fs.existsSync(local+ext))) return null;
         return this.resolve(id, importer.replace(overlayWeb, sourceWeb), {skipSelf:true});
       }
     },
     load(id){
       if(id===entryId) return entry;
       if(id.startsWith('\0voice-mock:')) return hookMocks[id.slice('\0voice-mock:'.length)];
     },
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
   // Upstream modules probe the server's environment descriptor; there is no server here.
   if(fileName.startsWith('.well-known/')) return route.fulfill({status:404,body:''});
   const output = outputs.find(output=>output.fileName===fileName);
   assert.ok(output, `Unexpected browser asset request: ${fileName}`);
   return route.fulfill({contentType:fileName.endsWith('.js')?'text/javascript':'application/octet-stream',
     body:output.type==='chunk'?output.code:Buffer.from(output.source)});
 });
 page.setDefaultTimeout(2000);
 const errors=[];page.on('pageerror',e=>{errors.push(e.message); console.error('Browser:',e.stack)});
 page.on('console',message=>{if(message.type()==='error') console.error('Browser console:',message.text())});
 async function reset(client=false) {
   await page.goto('http://voice.test');
   await page.setContent('<div id="root"></div>');
   await page.evaluate(value=>{window.clientVoice=value},client);
   await page.addScriptTag({content:script.code});
   await page.locator('[contenteditable]').waitFor();
 }
 async function recording(value) { await page.waitForFunction(v=>window.recording()===v, value, {timeout:2000}); }
 const mic = page.getByRole('button',{name:/^(Start|Stop) voice input$/});
 const editor = page.locator('[contenteditable]');
 const value = () => page.evaluate(()=>window.editorSnapshot().value);
 async function textIs(text) {try {await page.waitForFunction(expected=>window.editorSnapshot().value===expected,text,{timeout:2000});} catch(error) {console.error('Editor state:',await page.evaluate(()=>({value:window.editorSnapshot().value,stops:window.stops,recording:window.recording()})));throw error;}}
 async function editable(enabled) {await page.waitForFunction(expected=>document.querySelector('[contenteditable]').getAttribute('contenteditable')===String(expected),enabled);}
 async function start() {await page.evaluate(()=>window.focusEnd());await mic.click();await recording(true);}
 async function stop() {await mic.click();await recording(false);await editable(true);}

 // One Enter finishes dictation and sends the committed final text exactly once.
 for (const client of [false,true]) {
   for (const question of [false,true]) {
     await reset(client);
     if (!question) await page.evaluate(()=>window.leaveQuestion());
     await editor.fill('');await start();
     await page.evaluate(()=>{window.holdFinal=true});
     await page.keyboard.press('Enter');
     await page.waitForFunction(()=>window.stops===1);
     if (client) assert.equal(await page.evaluate(()=>window.capturing),false,'Enter releases the client microphone');
     assert.deepEqual(await page.evaluate(()=>window.sends),[],'wait for the final words, even with an initially empty draft');
     await page.keyboard.press('Enter');
     assert.equal(await page.evaluate(()=>window.stops),1,'repeated Enter does not stop twice');
     await page.evaluate(()=>{
       window.transcript('final spoken words');
       window.voiceEvent({type:'stopped',reason:'user-stop'});window.endStream({failure:false});
     });
     await recording(false);
     await page.waitForFunction(()=>window.sends.length===1);
     assert.deepEqual(await page.evaluate(()=>window.sends),[{
       text:'final spoken words',snapshot:'final spoken words',intent:'foreground',
       answers:question?{'question-1':'final spoken words'}:null,
     }]);
     await page.evaluate(()=>window.voiceEvent({type:'stopped',reason:'user-stop'}));
     assert.equal(await page.evaluate(()=>window.sends.length),1,'late stop events do not send twice');
   }
 }
 // The usual Enter modifiers and explicit Stop keep their existing behavior.
 await reset();await start();
 await editor.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
 assert.equal(await page.evaluate(()=>window.stops),0,'IME composition does not submit');
 await page.keyboard.press('Shift+Enter');await recording(true);
 assert.equal(await page.evaluate(()=>window.stops),0);await stop();
 assert.deepEqual(await page.evaluate(()=>window.sends),[],'manual Stop does not send');
 await reset();await page.evaluate(()=>window.leaveQuestion());await start();
 await page.keyboard.press('Control+Enter');await recording(false);
 await page.waitForFunction(()=>window.sends.length===1);
 assert.equal(await page.evaluate(()=>window.sends[0].intent),'background');

 // A queued send belongs to this recording and target, and still runs send checks.
 for (const cancel of ['question','thread','failure','limit','provider']) {
   await reset();await start();await page.evaluate(()=>{window.holdFinal=true});
   await page.keyboard.press('Enter');await page.waitForFunction(()=>window.stops===1);
   if (cancel==='question') await page.evaluate(()=>window.changeQuestion());
   if (cancel==='thread') await page.evaluate(()=>window.leaveQuestion());
   if (cancel==='failure') await page.evaluate(()=>window.endStream({failure:false}));
   if (cancel==='provider') await page.evaluate(()=>window.setNoProviderAvailable(true));
   await page.evaluate(reason=>{
     window.voiceEvent({type:'stopped',reason});window.endStream({failure:false});
   },cancel==='limit'?'recording-limit':'user-stop');
   await recording(false);
   assert.deepEqual(await page.evaluate(()=>window.sends),[],cancel+' must not dispatch the queued send');
 }
 console.log('PASS: '+channel+' Enter stops and sends final text once, preserves modifiers, and cancels on target changes or failure');

 // A spinning edge while starting and finishing; red only while speech is actually kept.
 async function micState(live,status) {
   await page.waitForFunction(([live,status])=>{
     const button=document.querySelector('[data-voice-live]');
     return button?.dataset.voiceLive===String(live) && document.querySelector('[role="status"]')?.textContent===status;
   },[live,status]);
   assert.match(await mic.getAttribute('class'),live?/\bbg-destructive\b/:/\bbg-secondary\b/);
   assert.equal(await mic.locator('[data-voice-pending]').count(),live?0:1);
 }
 for (const client of [false,true]) {
   await reset(client);await page.evaluate(()=>{window.deferListening=true});await start();
   await micState(false,'Starting microphone…');
   // Client audio before the stream opens, or a stream without audio, is not live yet.
   await page.evaluate(client=>client?window.audio():window.voiceEvent({type:'listening'}),client);
   await page.waitForTimeout(100);await micState(false,'Starting microphone…');
   await page.evaluate(client=>client?window.voiceEvent({type:'listening'}):window.voiceEvent({type:'level',value:0.2}),client);
   await micState(true,'Recording');
   await page.evaluate(()=>{window.holdFinal=true});await mic.click();
   await page.waitForFunction(()=>window.stops===1);
   await micState(false,'Finishing transcription…');
   await page.evaluate(client=>client?window.audio():window.voiceEvent({type:'level',value:0.2}),client);
   await page.waitForTimeout(100);await micState(false,'Finishing transcription…');
   await page.evaluate(()=>{window.voiceEvent({type:'stopped',reason:'user-stop'});window.endStream({failure:false})});
   await recording(false);
   assert.equal(await mic.getAttribute('data-voice-live'),null);
   // The next recording starts yellow again.
   await page.evaluate(()=>{window.holdFinal=false});await start();
   await micState(false,'Starting microphone…');await stop();
 }
 console.log('PASS: '+channel+' the mic spins while starting and finishing, and turns red only once the stream is open and audio arrives');

 // Recording must preserve focus so Alt+Q can stop it before the first transcript.
 await reset();await page.evaluate(()=>window.focusEnd());
 await page.keyboard.press('Alt+KeyQ');await recording(true);await editable(true);
 assert.equal(await editor.evaluate(el=>document.activeElement===el),true,'starting voice keeps editor focus');
 await page.keyboard.press('Alt+KeyQ');await recording(false);
 assert.equal(await page.evaluate(()=>window.stops),1);
 // A mic-button start can also be stopped by the shortcut after a transcript.
 await start();await page.evaluate(()=>window.transcript('shortcut test'));
 await textIs('answer prefix shortcut test');
 await page.keyboard.press('Alt+KeyQ');await recording(false);
 assert.equal(await page.evaluate(()=>window.stops),2);
 // Holding the shortcut stops when either key goes up; its key repeats type nothing.
 await page.evaluate(()=>{window.qKeys=[];window.addEventListener('keydown',e=>{if(e.code==='KeyQ')window.qKeys.push([e.repeat,e.defaultPrevented])})});
 await page.keyboard.down('Alt');await page.keyboard.down('KeyQ');await recording(true);await page.keyboard.down('KeyQ');
 await page.waitForTimeout(450);await page.keyboard.up('KeyQ');await page.keyboard.up('Alt');
 await recording(false);assert.equal(await page.evaluate(()=>window.stops),3);
 await page.keyboard.down('Alt');await page.keyboard.down('KeyQ');await recording(true);
 await page.waitForTimeout(450);await page.keyboard.up('Alt');await recording(false);await page.keyboard.up('KeyQ');
 assert.equal(await page.evaluate(()=>window.stops),4);
 assert.deepEqual(await page.evaluate(()=>window.qKeys),[[false,true],[true,true],[false,true]]);
 // AltGr+Q (Ctrl+Alt+Q on Windows) still types "@". Ctrl+T works where the browser passes it on.
 await page.keyboard.press('Control+Alt+KeyQ');await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.recording()),false);
 assert.deepEqual(await page.evaluate(()=>window.qKeys.at(-1)),[false,false]);
 await page.keyboard.press('Control+t');await recording(true);
 await page.keyboard.press('Control+t');await recording(false);
 assert.equal(await page.evaluate(()=>window.stops),5);

 // Real parent callback must not echo stale editor text when dictating before a suffix.
 await reset();await page.evaluate(()=>window.focusAt(6));await mic.click();await recording(true);
 await page.evaluate(()=>window.transcript('spoken'));
 await textIs('answer spoken prefix');
 assert.equal(await page.evaluate(()=>window.pendingText()),'answer spoken prefix');
 await page.evaluate(()=>{window.transcript('spoken words');window.transcript('spoken words here')});
 await textIs('answer spoken words here prefix');await stop();
 assert.deepEqual(await page.evaluate(()=>window.answer()),{'question-1':'answer spoken words here prefix'});
 assert.equal(await page.locator('output').textContent(),'chat draft stays here');

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
 assert.equal(await value(),'answer prefix spoken answer');
 // Editing remains available and does not stop recording. Subsequent speech may overwrite it.
 await editor.fill('manual edit during recording');
 await textIs('manual edit during recording');await recording(true);
 assert.equal(await page.evaluate(()=>window.stops),0);
 await page.evaluate(()=>window.transcript('spoken answer continues'));
 await textIs('answer prefix spoken answer continues');await recording(true);
 // Editing and the Stop button remain available while the provider finishes.
 await page.evaluate(()=>{window.holdFinal=true});
 await mic.click();
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
 await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent.includes('Reconnecting'));
 for(let i=0;i<40;i++) {await page.evaluate(()=>window.audio());await page.waitForTimeout(100);}
 await recording(true);await editable(true);
 assert.equal(await page.evaluate(()=>window.capturing),true);
 await mic.click();
 await page.waitForFunction(()=>!window.capturing);await editable(true);
 assert.equal(await page.evaluate(()=>window.stops),0,'Stop waits for queued audio');
 await page.evaluate(()=>{window.offline=false});
 await recording(false);await editable(true);
 assert.equal(await page.evaluate(()=>window.received),await page.evaluate(()=>window.captured));
 assert.equal(await value(),'answer prefix first words');
 assert.equal(await page.evaluate(()=>window.starts.slice(1).every(Boolean)),true);
 assert.deepEqual(await page.evaluate(()=>window.toasts),[]);
 // Hidden/unmounted editors must not seed a question recording with the chat draft.
 await reset();await page.evaluate(()=>{
   window.configureQuestion({customAnswer:''});
   window.snapshotOverride={value:'chat draft stays here',expandedCursor:20};
 });
 await mic.click();await recording(true);await page.evaluate(()=>window.transcript('question only'));
 await textIs('question only');await stop();
 assert.equal(await page.locator('output').textContent(),'chat draft stays here');

 // All editable question shapes use the same control, even without the normal footer.
 for (const shape of [
   {name:'free text',options:[]},
   {name:'single choice',options:[{label:'One'},{label:'Two'}],selectedOptionValues:['One']},
   {name:'multiple choice',options:[{label:'One'},{label:'Two'}],multiSelect:true,selectedOptionValues:['One','Two']},
   {name:'async question',options:[],dismissible:true},
 ]) {
   for (const layout of ['desktop','mobile','collapsed']) {
     await reset();await page.evaluate(({shape,layout})=>{window.configureQuestion({...shape,customAnswer:''});window.setLayout(layout)},{shape,layout});
     await mic.waitFor({state:'visible'});assert.equal(await mic.count(),1,shape.name+' '+layout);
     await mic.click();await recording(true);
     await page.evaluate(()=>{window.transcript('spoken');window.transcript('spoken answer')});
     await textIs('spoken answer');await mic.click();await recording(false);
     assert.deepEqual(await page.evaluate(()=>window.answer()),{'question-1':'spoken answer'},shape.name+' '+layout);
     assert.equal(await page.locator('output').textContent(),'chat draft stays here');
     // Alt+Q works from question controls even when the editor is hidden.
     await page.locator('[data-pending-user-input-toggle]').focus();
     await page.keyboard.press('Alt+KeyQ');await recording(true);
     await page.evaluate(()=>window.transcript('more'));await textIs('spoken answer more');
     assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('[data-chat-composer-form]'))),true,'dictation must keep the stop shortcut reachable');
     await page.keyboard.press('Alt+KeyQ');await recording(false);
   }
 }
 // Provider-enforced choices and approval controls have no writable answer target.
 await reset();await page.evaluate(()=>window.configureQuestion({allowCustomAnswer:false,options:[{label:'Yes'}]}));
 assert.equal(await mic.count(),0);await page.locator('[data-pending-user-input-toggle]').focus();
 await page.keyboard.press('Alt+KeyQ');await recording(false);assert.deepEqual(await page.evaluate(()=>window.starts),[]);
 await reset();await page.evaluate(()=>window.setApproval(true));assert.equal(await mic.count(),0);
 await reset();await page.evaluate(()=>window.setResponding(true));assert.equal(await mic.isDisabled(),true);
 // A replaced request can reuse the same question id; late speech must still be rejected.
 await reset();await start();await page.evaluate(()=>window.configureQuestion({requestId:'next-request',customAnswer:'new answer'}));
 await recording(false);await page.evaluate(()=>window.transcript('late old request'));await textIs('new answer');
 // Submitting elsewhere stops dictation instead of accepting further partials.
 await reset();await start();await page.evaluate(()=>window.setResponding(true));await recording(false);
 await page.evaluate(()=>window.transcript('late submission'));await textIs('answer prefix');
 assert.deepEqual(errors,[]);
 console.log('PASS: '+channel+' real question panel and parent callbacks: editable question shapes, compact controls, mid-answer insertion, focus and stop shortcuts, editable capture/finalization, batched partials, repeated long drafts, target changes, late results and offline Stop');
} finally {await browser.close();}
