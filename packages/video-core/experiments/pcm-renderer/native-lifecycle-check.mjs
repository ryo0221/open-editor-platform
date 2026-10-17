import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const out = process.argv[2];
if (!out) throw Error('fresh output directory required');
await mkdir(out);
const actual = path.resolve('packages/video-core/experiments/pcm-renderer/native-aac.mjs');
const mockInput = `
export const ALL_FORMATS=[];export class BufferSource{}
export class Input {
 constructor(){const s=globalThis.lifecycleStub;s.counts.inputs++;if(s.phase==='input-constructor')s.abort();}
 getPrimaryAudioTrack(){const s=globalThis.lifecycleStub;s.counts.trackCalls++;return s.schedule('track',{
  getDecoderConfig(){s.counts.configCalls++;return s.schedule('config',{codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2});}
 });}
 dispose(){globalThis.lifecycleStub.counts.inputDisposals++;}
}
export class EncodedPacketSink {constructor(){globalThis.lifecycleStub.counts.packetSinks++;}async *packets(){throw Error('Unexpected packet read');}}
`;
const built = await build({
  plugins: [
    {
      name: 'controlled-lifecycle-ports',
      setup(b) {
        b.onResolve({ filter: /^mediabunny$/ }, () => ({ path: 'input', namespace: 'probe' }));
        b.onResolve({ filter: /local-codec\/browser-aac\.mjs$/ }, () => ({
          path: 'timing',
          namespace: 'probe',
        }));
        b.onLoad({ filter: /.*/, namespace: 'probe' }, ({ path: p }) => ({
          loader: 'js',
          contents:
            p === 'input'
              ? mockInput
              : `export function savedTiming(){return {mediaScale:48000,validStart:0,validEnd:{n:10000n,d:1n},samples:[{pts:0,duration:1024}]};}`,
        }));
      },
    },
  ],
  stdin: {
    resolveDir: process.cwd(),
    contents: `
import {decodeWindow} from ${JSON.stringify(actual)};
globalThis.probe=async(phase)=>{
 const abort=new AbortController(),counts={inputs:0,inputDisposals:0,trackCalls:0,configCalls:0,supportCalls:0,created:0,configured:0,closed:0,packetSinks:0};
 const schedule=(at,value)=>{const p=Promise.resolve(value);
  if(phase===at)queueMicrotask(()=>queueMicrotask(()=>abort.abort()));return p;};
 globalThis.lifecycleStub={counts,schedule,phase,abort:()=>abort.abort()};const original=globalThis.AudioDecoder;
 globalThis.AudioDecoder=class {
  static isConfigSupported(config){counts.supportCalls++;return schedule('support',{supported:true,config});}
  constructor(){counts.created++;this.state='unconfigured';if(phase==='constructor')abort.abort();}
  configure(){counts.configured++;this.state='configured';if(phase==='configure')abort.abort();}
  close(){if(this.state==='closed')throw Error('Double close');counts.closed++;this.state='closed';}
 };
 let outcome='unexpected-success',cleanup;
 try{await decodeWindow(new ArrayBuffer(8),{first:100,end:200,rate:48000,channels:2},abort.signal,{onClosed:v=>{cleanup=v;}});}
 catch(e){outcome=e.name;}finally{globalThis.AudioDecoder=original;delete globalThis.lifecycleStub;}
 const shouldCreate=['constructor','configure'].includes(phase)?1:0;
 const pass=outcome==='AbortError'&&counts.inputs===1&&counts.inputDisposals===1&&counts.created===shouldCreate&&counts.closed===shouldCreate&&counts.packetSinks===0&&counts.trackCalls===(phase==='input-constructor'?0:1)&&counts.configCalls===(['input-constructor','track'].includes(phase)?0:1)&&counts.supportCalls===(['input-constructor','track','config'].includes(phase)?0:1)&&counts.configured===(phase==='configure'?1:0)&&cleanup?.decoderClosed&&cleanup?.inputDisposed;
 return {phase,outcome,counts,cleanup,state:pass?'PASS':'FAIL'};
};`,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((_q, r) => r.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: built.outputFiles[0].text });
  for (const phase of [
    'input-constructor',
    'track',
    'config',
    'support',
    'constructor',
    'configure',
  ])
    results.push(await page.evaluate((p) => globalThis.probe(p), phase));
  if (errors.length) results.push({ state: 'FAIL', errors });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(
  path.join(out, 'results.json'),
  JSON.stringify(
    {
      code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
      kind: 'actual-adapter-control-flow-with-stubbed-codec-and-input',
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.state !== 'PASS')) process.exitCode = 1;
