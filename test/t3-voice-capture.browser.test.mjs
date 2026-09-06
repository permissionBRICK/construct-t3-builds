// Exercise the real AudioWorklet and capture lifecycle with Chromium's fake microphone.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(process.env.T3_TEST_TOOLS, 'package.json'));
const {build} = require('esbuild');
const {chromium} = require('playwright');
const channel = process.env.T3_TEST_CHANNEL || 'release';
const entry = `
import {startClientAudioCapture} from ${JSON.stringify(path.join(root, `patches/t3code-${channel}/overlays/apps/web/src/voice/clientAudioCapture.ts`))};
const OriginalAudioContext=window.AudioContext;
window.AudioContext=class extends OriginalAudioContext {constructor(...args){super(...args);window.context=this}};
window.begin=()=>{
 window.bytes=0;window.errors=[];
 window.capture=startClientAudioCapture({onChunk:c=>{window.bytes+=c.length},onLevel:()=>{},onError:e=>window.errors.push(e)});
};`;
const bundle = await build({stdin:{contents:entry,loader:'ts',resolveDir:root},bundle:true,write:false,platform:'browser'});
const browser = await chromium.launch({headless:true, executablePath:process.env.T3_TEST_CHROMIUM, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html',body:'<button onclick="begin()">Record</button>'}));
 async function reset(){await page.goto('http://localhost/');await page.addScriptTag({content:bundle.outputFiles[0].text});}
 await reset();
 await page.getByText('Record').click();
 await page.waitForFunction(()=>window.bytes>3200);
 await page.evaluate(()=>window.capture.finish());
 assert.equal(await page.evaluate(()=>window.context.state),'closed');
 assert.deepEqual(await page.evaluate(()=>window.errors),[]);
 const bytes=await page.evaluate(()=>window.bytes);
 await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>window.bytes),bytes,'finished capture produces no further audio');
 await reset();
 await page.getByText('Record').click();
 await page.waitForFunction(()=>window.bytes>3200);
 await page.evaluate(()=>window.context.suspend());
 await page.waitForFunction(()=>window.errors.length===1);
 assert.match(await page.evaluate(()=>window.errors[0]),/browser paused microphone/);
 assert.equal(await page.evaluate(()=>window.context.state),'closed');
 assert.deepEqual(errors,[]);
 console.log(`PASS: ${channel} real microphone capture, graceful AudioWorklet flush, and interruption diagnostics`);
} finally { await browser.close(); }
