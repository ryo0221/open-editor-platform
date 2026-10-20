/** Actual existing product guard with deterministic decoded PCM; codec/Host are not certified here. */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const root = path.dirname(fileURLToPath(import.meta.url));
const [built, out] = process.argv.slice(2);
if (!built || !out) throw Error('build fresh-output required');
await mkdir(out);
const timeline = path.resolve(
  root,
  '../../../video-metadata/host-media/file-source/timeline-v1.mjs',
);
const source = await readFile(timeline);
const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
import {timelinePcmV1} from ${JSON.stringify(timeline)};
import {prepareModule,Ledger} from '../../src/pcm/kernel';
export async function run(bytes,sha) {
 const realm=new Ledger(8*1024*1024),pin=await prepareModule(bytes,sha,realm), results=[];
 for(const mode of ['js','wasm']) for(const amplitude of [0.25,2,Infinity]) {
  const fixture=globalThis.r0Fixture={mode,pin,realm,backends:[],leases:[],drains:[],pcm:{first:0,rate:48000,planes:[new Float32Array(128).fill(amplitude)]},mapping:{start:{value:0,timescale:1},end:{value:1,timescale:375},sourceStart:{value:0,timescale:1},speed:{value:1,timescale:1}},valid:{start:{value:0,timescale:1},end:{value:1,timescale:375}}};
  const plan={count:128,original:{bytes:new Uint8Array()},audio:[{id:'a',start:{value:0,timescale:1},duration:{value:1,timescale:375}}],audioStream:{sampleRate:48000},content:{},source:{asset:{sha256:'test'}}};
  const pcm=await timelinePcmV1(plan,new AbortController().signal);let error;
  try {await pcm.render(0,128,new AbortController().signal);}catch(e){error=String(e);}
  await pcm.dispose();for(const lease of fixture.leases)lease.release();await Promise.all(fixture.drains);
  if(amplitude===0.25&&error)throw Error(error);
  if(amplitude===2&&!error?.includes('v1 PCM clipping/nonfinite'))throw Error('Actual product clipping guard did not reject');
  if(amplitude===Infinity&&!error?.includes('Nonfinite PCM'))throw Error('Invalid input not rejected');
  results.push({mode,amplitude:String(amplitude),error,diagnostics:fixture.backends.map(b=>b.diagnostics)});
 }
 // Finite source may become Infinity in the raw kernel. Inject the raw backend result into the
 // same actual product function after the session boundary to test the downstream guard itself.
 for(const mode of ['js','wasm']) {
   const f=globalThis.r0Fixture;f.mode=mode;f.injectRawInfinity=true;f.leases=[];f.drains=[];f.backends=[];
   const p={count:128,original:{bytes:new Uint8Array()},audio:[{id:'a',start:{value:0,timescale:1},duration:{value:1,timescale:375}}],audioStream:{sampleRate:48000},content:{},source:{asset:{sha256:'test'}}};
   const pcm=await timelinePcmV1(p,new AbortController().signal);let rejected=false;
   try{await pcm.render(0,128,new AbortController().signal);}catch(e){rejected=String(e).includes('v1 PCM clipping/nonfinite');}
   await pcm.dispose();await Promise.all(f.drains);if(!rejected)throw Error('Raw Infinity product guard');results.push({mode,rawInfinityRejected:true});
 }
 pin.dispose();if(realm.bytes!==0)throw Error('Guard lease leak');delete globalThis.r0Fixture;return results;
}`,
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'private-codec-fixtures',
      setup(b) {
        b.onResolve({ filter: /src\/pcm\/session\.ts$/ }, () => ({
          path: 'session',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /timing-v1$/ }, (a) =>
          a.importer === timeline ? { path: 'timing', namespace: 'fixture' } : undefined,
        );
        b.onResolve({ filter: /indexed-media\/pcm-file\.mjs$/ }, () => ({
          path: 'pcm',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /indexed-media\/video-window\.mjs$/ }, () => ({
          path: 'video',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
          loader: 'js',
          resolveDir: root,
          contents:
            a.path === 'session'
              ? `
import {PcmBackend} from '../../src/pcm/adapter';import {Tile,WasmKernel,jsKernel} from '../../src/pcm/kernel';
export class PcmRenderSession {
 constructor(){const f=globalThis.r0Fixture;this.b=new PcmBackend({mode:f.mode,pin:f.pin,realm:f.realm,yieldTask:async()=>{}});f.backends.push(this.b);}
 async render(m,first,end,rate,_sr,valid,_ch,signal){const f=globalThis.r0Fixture;
 if(f.injectRawInfinity){const t=new Tile();t.source[0]=Math.fround(3.4028234663852886e38);t.weights[0]=2;t.lengths[0]=1;t.totals[0]=1;if(f.mode==='wasm')new WasmKernel(f.pin).run(t,1,1,1);else jsKernel(t,1,1,1);return {first,rate,planes:[new Float32Array(end-first).fill(t.output[0])]};}
 const out=await this.b.render(m,first,end,rate,f.pcm,signal,{mode:'edge-hold-v0',valid});f.leases.push(out);return out.pcm;}
 dispose(){globalThis.r0Fixture.drains.push(this.b.close());}
}`
              : a.path === 'timing'
                ? `export const audioMappingV1=()=>({mapping:globalThis.r0Fixture.mapping,valid:globalThis.r0Fixture.valid});export const outputSpanV1=()=>{throw Error('unused')};`
                : a.path === 'pcm'
                  ? `export const createPcmFile=async()=>({acquire:()=>({release(){}}),dispose:async()=>{},evidence:{stubbed:true}});`
                  : `export const createVideoWindow=()=>{throw Error('unused')};`,
        }));
      },
    },
  ],
});
const file = path.join(path.resolve(out), 'guard.mjs');
await writeFile(file, bundle.outputFiles[0].text);
const bytes = new Uint8Array(await readFile(path.join(built, 'pcm.wasm'))),
  sha = createHash('sha256').update(bytes).digest('hex');
try {
  const { run } = await import(pathToFileURL(file).href);
  const results = await run(bytes, sha);
  await writeFile(
    path.join(out, 'results.json'),
    JSON.stringify(
      {
        state: 'PASS',
        code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        engine: process.version,
        wasmSha256: sha,
        actualGuardSourceSha256: createHash('sha256').update(source).digest('hex'),
        limits:
          'Stubbed decoder and session binding; actual existing timeline product guard; not canonical Host or codec verification',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS actual common product guard');
} catch (e) {
  await writeFile(path.join(out, 'failure.txt'), String(e) + '\n' + e.stack);
  throw e;
}
