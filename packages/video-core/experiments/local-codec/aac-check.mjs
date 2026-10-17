import { Buffer } from 'node:buffer';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, out] = process.argv.slice(2);
assert(deps && out);
await mkdir(out);
const bundle = await build({
  stdin: {
    resolveDir: deps,
    contents: `
import { Output,Mp4OutputFormat,BufferTarget,AudioSampleSource,AudioSample } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
registerAacEncoder();
globalThis.encodeCase=async({rate,count,origin})=>{
 const pcm=new Float32Array(count*2);pcm[Math.floor(count/4)*2]=0.75;pcm[Math.floor(count*3/4)*2+1]=0.75;
 const target=new BufferTarget(),output=new Output({format:new Mp4OutputFormat(),target});
 const source=new AudioSampleSource({codec:'aac',bitrate:128000});output.addAudioTrack(source);await output.start();
 const sample=new AudioSample({data:pcm,format:'f32',numberOfChannels:2,sampleRate:rate,timestamp:origin});
 try{await source.add(sample);}finally{sample.close();}await output.finalize();
 const bytes=target.buffer, context=new OfflineAudioContext(2,1,rate), decoded=await context.decodeAudioData(bytes.slice(0));
 return {bytes:Array.from(new Uint8Array(bytes)),browserFrames:decoded.length,browserRate:decoded.sampleRate,browserChannels:decoded.numberOfChannels};
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
  for (const rate of [44100, 48000])
    for (const count of [1, 17, rate + 123])
      for (const origin of [0, 0.125]) {
        const page = await browser.newPage(),
          name = `aac-${rate}-${count}-${origin}`;
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.addScriptTag({ content: bundle.outputFiles[0].text });
          const data = await page.evaluate((args) => globalThis.encodeCase(args), {
              rate,
              count,
              origin,
            }),
            bytes = Buffer.from(data.bytes),
            file = path.join(out, name + '.mp4');
          await writeFile(file, bytes);
          const probe = JSON.parse(
            execFileSync(
              'ffprobe',
              ['-v', 'error', '-show_packets', '-show_streams', '-of', 'json', file],
              { maxBuffer: 8 * 1024 * 1024 },
            ),
          );
          const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-'], {
            maxBuffer: 8 * 1024 * 1024,
          });
          const ffmpegFrames = pcm.length / 8;
          const checks = {
            browserFrameCount: data.browserFrames === count,
            ffmpegFrameCount: ffmpegFrames === count,
            rate: data.browserRate === rate && Number(probe.streams[0].sample_rate) === rate,
            channels: data.browserChannels === 2,
            origin: Math.abs(Number(probe.streams[0].start_time) - origin) <= 1 / rate,
          };
          const result = {
            name,
            status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
            count,
            rate,
            origin,
            browserFrames: data.browserFrames,
            ffmpegFrames,
            checks,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
          results.push(result);
          await writeFile(path.join(out, name + '.probe.json'), JSON.stringify(probe, null, 2));
          console.log(result);
        } catch (e) {
          results.push({ name, status: 'FAIL', error: String(e) });
          console.log(results.at(-1));
        } finally {
          await page.close();
        }
      }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
