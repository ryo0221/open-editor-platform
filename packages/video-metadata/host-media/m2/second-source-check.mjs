// Approved local original only; never uploads or modifies media bytes.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, original, out] = process.argv.slice(2);
await mkdir(out);
const built = await build({
  stdin: {
    contents: `
import {inspectOriginalV1} from './packages/video-metadata/host-media/file-source/inspect-v1.ts';
import {createPcmFile} from './packages/video-metadata/host-media/indexed-media/pcm-file.mjs';
import {createVideoWindow,videoStatus} from './packages/video-metadata/host-media/indexed-media/video-window.mjs';
import {scratchStatus} from './packages/video-metadata/host-media/indexed-media/scratch.mjs';
import {time} from '@editor-platform/video-core';
globalThis.inspectSecond = async () => {
 const original=document.querySelector('input').files[0], signal=new AbortController().signal;
 if(original.size!==152552809) throw Error('Approved original size');
 original.arrayBuffer=()=>{throw Error('Whole original read forbidden');};
 const {plan}=await inspectOriginalV1(original,signal),a=plan.streams.find(s=>s.kind==='audio');
 let pcm,video,frame;
 try {
   pcm=await createPcmFile(original,signal,{originalHash:'2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022',streamId:a.id,decodePolicy:'native-aac-continuous-v1'},'iphone-sdr-v1');
   const tail=await pcm.decode({first:pcm.valid.end-32,end:pcm.valid.end,rate:pcm.valid.rate,channels:1},signal);
   video=await createVideoWindow(original,signal,'iphone-sdr-v1');
   const last=video.clock.samples.at(-1);
   frame=await video.frameAt(time(last.pts,video.clock.scale),signal);
   const canvas=document.querySelector('canvas');canvas.width=480;canvas.height=270;
   canvas.getContext('2d').drawImage(frame.frame,0,0,480,270);
   return {plan,rawPcm:pcm.valid,pcmEvidence:pcm.evidence,tailFinite:tail.planes[0].every(Number.isFinite),video:{rotation:video.rotation,pts:frame.pts,scale:video.clock.scale,lastDuration:last.duration,evidence:video.evidence}};
 } finally {frame?.release();await video?.dispose();await pcm?.dispose();globalThis.after={video:videoStatus(),scratch:scratchStatus()};}
};`,
    resolveDir: process.cwd(),
    sourcefile: 'second-source-entry.mjs',
  },
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].text
      : '<!doctype html><input type="file"><canvas></canvas><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let result;
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('input').setInputFiles(original);
  const proof = await page.evaluate(() => globalThis.inspectSecond());
  const after = await page.evaluate(() => globalThis.after);
  assert.equal(proof.tailFinite, true);
  assert.equal(proof.video.rotation, 0);
  assert.equal(proof.video.pts, 42571);
  assert.equal(proof.video.scale, 600);
  assert.equal(after.video.sessions, 0);
  assert.equal(after.scratch.files, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(out, 'second-original.png') });
  result = {
    state: 'PASS',
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    proof,
    after,
    errors,
  };
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
