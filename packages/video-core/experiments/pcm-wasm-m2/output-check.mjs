/** Actual pinned AudioSample resource refs; controlled add/clone delays, no codec claims. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
const [deps, out] = process.argv.slice(2);
await mkdir(out);
const entry = resolve(out, 'entry.mjs');
await writeFile(
  entry,
  `import assert from 'node:assert/strict';
import {addOwnedAudio} from ${JSON.stringify(resolve('packages/video-metadata/host-media/m2/pcm-output.mjs'))};
for (const fail of [false,true]) {
 let bytes=0, peak=0, releases=0, clone, resolveEntered;
 const entered=new Promise(r=>resolveEntered=r);
 const owner={reserve(n){bytes+=n;peak=Math.max(peak,bytes);let live=true;return()=>{if(live){live=false;bytes-=n}}}};
 const input=owner.reserve(16);
 const chunk={first:0,planes:[new Float32Array([0,-0,0.25,-0.5])],release(){input();releases++}};
 let settled=false;
 const work=addOwnedAudio({async add(sample){clone=sample.clone();resolveEntered();if(fail)throw Error('controlled add failure')}},chunk,owner,()=>{});
 const observed=work.then(()=>({ok:true}),e=>({ok:false,error:String(e)})).then(r=>{settled=true;return r});
 await entered;
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(settled,false);assert.equal(bytes,fail?16:32);assert.equal(releases,fail?1:0);
 const pcm=new Float32Array(4);clone.copyTo(pcm,{planeIndex:0,format:'f32'});
 assert.deepEqual([...new Uint32Array(pcm.buffer)],[0,2147483648,1048576000,3204448256]);
 clone.close();const result=await observed;
 assert.equal(result.ok,!fail);if(fail)assert.equal(result.error,'Error: controlled add failure');
 assert.equal(bytes,0);assert.equal(releases,1);assert.equal(peak,80);
}
console.log('PASS actual resource clone lifetime, successful/rejected add, exact input bits, full tracked overlap/drain');`,
);
const file = resolve(out, 'check.mjs');
await build({
  entryPoints: [entry],
  outfile: file,
  bundle: true,
  platform: 'node',
  format: 'esm',
  nodePaths: [resolve(deps, 'node_modules')],
});
execFileSync(process.execPath, [file], { stdio: 'inherit' });

const hashFile = resolve(out, 'hash-check.mjs');
await build({
  entryPoints: [resolve('packages/video-core/experiments/pcm-wasm-m2/hash-check-fixture.mjs')],
  outfile: hashFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  nodePaths: [resolve(deps, 'node_modules')],
});
execFileSync(process.execPath, [hashFile], { stdio: 'inherit' });
