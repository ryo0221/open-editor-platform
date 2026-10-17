import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out] = process.argv.slice(2);
await mkdir(out);
for (const [name, rate, channels] of [
  ['mono44', 44100, 1],
  ['mono48', 48000, 1],
  ['stereo', 44100, 2],
]) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${rate}:duration=2`,
    '-ac',
    String(channels),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    path.join(out, name + '.m4a'),
  ]);
}
const bundle = await build({
  stdin: {
    contents: `
import {inspectAudioOriginalV2} from './packages/video-metadata/host-media/m2/audio-profile-v2.ts';
import {inspectOriginalV1} from './packages/video-metadata/host-media/file-source/inspect-v1.ts';
import {createPcmFile} from './packages/video-metadata/host-media/indexed-media/pcm-file.mjs';
import {scratchStatus} from './packages/video-metadata/host-media/indexed-media/scratch.mjs';
import {PcmRenderSession} from './packages/video-core/experiments/pcm-renderer/session.ts';
import {time,subtract} from '@editor-platform/video-core';
import {prepareAudioImportV2} from './packages/video-metadata/host-media/m2/audio-import-v2.ts';
globalThis.checkAdmission=async()=>{
 const file=document.querySelector('input').files[0],signal=new AbortController().signal;
 const before={schema:'video-core-prototype-v2',sources:[],sequence:{id:'seq',duration:time(0),frameRate:time(25),tracks:[{id:'audio',kind:'audio',enabled:true,locked:false}],clips:[]}};
 let native=before,published=false,error;
 try { const {plan}=await inspectAudioOriginalV2(file,signal); published=true; native=prepareAudioImportV2(before,plan,{assetId:'a',sha256:'a'.repeat(64),byteLength:file.size},'s',time(0)); } catch(e) {error=String(e);}
 return {published,error,unchanged:native===before,after:scratchStatus()};
};
globalThis.checkAudio=async(hash)=>{
 const file=document.querySelector('input').files[0], signal=new AbortController().signal;
 file.arrayBuffer=()=>{throw Error('Whole original prohibited');};
 let oldRefusal;try{await inspectOriginalV1(file,signal);}catch(e){oldRefusal=String(e);}
 const {plan}=await inspectAudioOriginalV2(file,signal),s=plan.streams[0];
 const pcm=await createPcmFile(file,signal,{originalHash:hash,streamId:s.id,decodePolicy:'native-aac-continuous-v1'},'aac-mono-v2');
 const lease=pcm.acquire(),renderer=new PcmRenderSession(lease,'edge-hold-v0');
 try {
  const mapping={start:time(0),end:subtract(s.mediaEnd,s.mediaStart),sourceStart:subtract(s.mediaStart,s.sampleOrigin),speed:time(1)};
  const valid={start:subtract(s.mediaStart,s.sampleOrigin),end:subtract(s.mediaEnd,s.sampleOrigin)};
  const block=await renderer.render(mapping,48000,49024,48000,s.sampleRate,valid,1,signal);
  return {plan,oldRefusal,raw:pcm.valid,pcm:Array.from(block.planes[0]),evidence:pcm.evidence};
 } finally {renderer.dispose();lease.release();await pcm.dispose();globalThis.after=scratchStatus();}
};`,
    resolveDir: process.cwd(),
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
      ? bundle.outputFiles[0].text
      : '<!doctype html><input type="file"><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const results = [];
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const name of ['mono44', 'mono48']) {
    const file = path.join(out, name + '.m4a'),
      hash = execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0];
    await page.locator('input').setInputFiles(file);
    const result = await page.evaluate((hash) => globalThis.checkAudio(hash), hash);
    assert.match(result.oldRefusal, /One video/);
    assert.equal(result.plan.profile, 'aac-mono-v2');
    const raw = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-f',
      'f32le',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-',
    ]);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let max = 0,
      squares = 0;
    result.pcm.forEach((value, i) => {
      assert(Number.isFinite(value));
      const d = value - view.getFloat32((48000 + i) * 4, true);
      max = Math.max(max, Math.abs(d));
      squares += d * d;
    });
    const rms = Math.sqrt(squares / result.pcm.length);
    assert(max < 0.005);
    assert(rms < 0.001);
    const after = await page.evaluate(() => globalThis.after);
    assert.equal(after.files, 0);
    assert.equal(after.bytes, 0);
    results.push({
      name,
      hash,
      ...result,
      oracle: { max, rms, decodedSha256: createHash('sha256').update(raw).digest('hex') },
      after,
    });
  }
  await page.locator('input').setInputFiles(path.join(out, 'stereo.m4a'));
  const admission = await page.evaluate(() => globalThis.checkAdmission());
  assert.equal(admission.published, false, 'Stereo interpretation was published');
  assert.equal(admission.unchanged, true, 'Rejected import changed native');
  assert.match(admission.error, /mono/i);
  assert.equal(admission.after.files, 0);
  assert.deepEqual(errors, []);
  results.push({ stereoRejected: true, admission, errors });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const report = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  results,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    state: report.state,
    code: report.code,
    results: results.map((r) => ({
      name: r.name,
      oracle: r.oracle,
      after: r.after,
      stereoRejected: r.stereoRejected,
      errors: r.errors,
    })),
  }),
);
