import { Buffer } from 'node:buffer';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, out] = process.argv.slice(2);
assert(deps && out);
await mkdir(out);
// Reproducible in-memory patch of the fixed candidate; installed files stay intact.
const bundle = await build({
  plugins: [
    {
      name: 'packet-pts',
      setup(b) {
        b.onLoad({ filter: /mediabunny-aac-encoder\.mjs$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8');
          assert.equal(
            createHash('sha256').update(contents).digest('hex'),
            'a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214',
          );
          const old = 'this.nextPacketTimestampInSamples / this.sampleRate,';
          assert.equal(contents.split(old).length, 2);
          contents = contents.replace(old, 'Number(p.pts) / this.sampleRate,');
          const duration = 'p.duration / this.sampleRate';
          assert.equal(contents.split(duration).length, 2);
          contents = contents.replace(
            duration,
            'Math.min(p.duration,globalThis.validEnd-Number(p.pts)) / this.sampleRate',
          );
          contents = contents.replace(
            'const packet = new EncodedPacket(',
            'globalThis.rawPackets.push({pts:Number(p.pts),duration:p.duration}); const packet = new EncodedPacket(',
          );
          return { contents, loader: 'js' };
        });
      },
    },
  ],
  stdin: {
    resolveDir: deps,
    contents: `
import { Output,Mp4OutputFormat,BufferTarget,AudioSampleSource,AudioSample,VideoSampleSource,VideoSample } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
registerAacEncoder();
globalThis.encodeCase=async({rate,count,origin})=>{
 globalThis.validEnd=Math.round(origin*rate)+count;globalThis.rawPackets=[]; const pcm=new Float32Array(count*2);pcm[Math.floor(count/4)*2]=0.75;pcm[Math.floor(count*3/4)*2+1]=0.75;
 const target=new BufferTarget(),output=new Output({format:new Mp4OutputFormat(),target});
 const source=new AudioSampleSource({codec:'aac',bitrate:128000});output.addAudioTrack(source);
 const withVideo=count>1024, video=withVideo?new VideoSampleSource({codec:'avc',bitrate:1000000}):null;
 if(video)output.addVideoTrack(video);await output.start();
 const sample=new AudioSample({data:pcm,format:'f32',numberOfChannels:2,sampleRate:rate,timestamp:origin});
 try{await source.add(sample);}finally{sample.close();}
 if(video){const canvas=new OffscreenCanvas(96,64),ctx=canvas.getContext('2d'),positions=[0,Math.floor(count/4),Math.floor(count*3/4),count];
 for(let i=0;i<3;i++){ctx.fillStyle=['black','red','blue'][i];ctx.fillRect(0,0,96,64);const frame=new VideoSample(canvas,{timestamp:origin+positions[i]/rate,duration:(positions[i+1]-positions[i])/rate});try{await video.add(frame);}finally{frame.close();}}}
 await output.finalize();
 const bytes=globalThis.correctMetadata(target.buffer,{rate,count,origin,rawPackets:globalThis.rawPackets}), context=new globalThis.OfflineAudioContext(2,1,rate), decoded=await context.decodeAudioData(bytes.slice(0));
 return {bytes:Array.from(new Uint8Array(bytes)),timingEvidence:globalThis.timingEvidence,rawPackets:globalThis.rawPackets,browserPcm:Array.from({length:decoded.length},(_,i)=>[decoded.getChannelData(0)[i],decoded.getChannelData(1)[i]]).flat(),browserFrames:decoded.length,browserRate:decoded.sampleRate,browserChannels:decoded.numberOfChannels};
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
    for (const count of [1, 17, 1024, 1025, rate + 123, rate * 3 + 29])
      for (const origin of [0, 0.125]) {
        const page = await browser.newPage(),
          name = `aac-${rate}-${count}-${origin}`;
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.addScriptTag({
            content: 'globalThis.correctMetadata=' + correctMetadata.toString(),
          });
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
          const pcm = execFileSync(
            'ffmpeg',
            ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
            {
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          const ffmpegFrames = pcm.length / 8;
          const nativeSamples = Array.from(
            new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
          );
          function peaks(samples) {
            return [0, 1].map((ch) => {
              let peak = 0,
                value = 0;
              for (let i = ch; i < samples.length; i += 2)
                if (Math.abs(samples[i]) > value) {
                  value = Math.abs(samples[i]);
                  peak = (i - ch) / 2;
                }
              return { peak, value };
            });
          }
          const expectedPeaks = [Math.floor(count / 4), Math.floor((count * 3) / 4)];
          const nativePeaks = peaks(nativeSamples),
            browserPeaks = peaks(data.browserPcm);
          const waveformAligned = [nativePeaks, browserPeaks].every((ps) =>
            ps.every((p, i) => Math.abs(p.peak - expectedPeaks[i]) <= 2 && p.value > 0.01),
          );
          const audio = probe.streams.find((s) => s.codec_type === 'audio');
          let avSync = null;
          if (count > 1024) {
            const video = JSON.parse(
              execFileSync('ffprobe', [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_frames',
                '-of',
                'json',
                file,
              ]),
            ).frames;
            const rgb = execFileSync('ffmpeg', [
              '-v',
              'error',
              '-i',
              file,
              '-map',
              '0:v:0',
              '-vf',
              'scale=1:1',
              '-fps_mode',
              'passthrough',
              '-pix_fmt',
              'rgb24',
              '-f',
              'rawvideo',
              '-',
            ]);
            const expectedColors = [
              [0, 0, 0],
              [255, 0, 0],
              [0, 0, 255],
            ];
            const colors =
              rgb.length === 9 &&
              expectedColors.every((c, i) =>
                c.every((v, ch) => Math.abs(rgb[i * 3 + ch] - v) <= 8),
              );
            const differences = nativePeaks.map(
              (p, i) =>
                Number(video[i + 1]?.best_effort_timestamp_time) -
                (Number(audio.start_time) + p.peak / rate),
            );
            avSync = {
              colors,
              videoFrames: video.length,
              differences,
              pass:
                colors &&
                video.length === 3 &&
                differences.every((d) => Math.abs(d) <= 2 / rate + 1 / 90000),
            };
          }
          const originalPcm = new Float32Array(count * 2);
          originalPcm[Math.floor(count / 4) * 2] = 0.75;
          originalPcm[Math.floor((count * 3) / 4) * 2 + 1] = 0.75;
          const controlFile = path.join(out, name + '-native-control.mp4');
          execFileSync(
            'ffmpeg',
            [
              '-v',
              'error',
              '-f',
              'f32le',
              '-ar',
              String(rate),
              '-ac',
              '2',
              '-i',
              'pipe:0',
              '-af',
              'asetpts=PTS+' + Math.round(origin * rate),
              '-c:a',
              'aac',
              '-b:a',
              '128000',
              '-movie_timescale',
              String(rate),
              controlFile,
            ],
            { input: Buffer.from(originalPcm.buffer) },
          );
          async function inspect(file) {
            const probe = JSON.parse(
              execFileSync('ffprobe', [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_packets',
                '-show_streams',
                '-of',
                'json',
                file,
              ]),
            );
            const stream = probe.streams[0];
            const decodes = {};
            for (const [mode, args] of [
              ['normal', []],
              ['ignoreEdits', ['-ignore_editlist', '1']],
            ]) {
              const b = execFileSync(
                'ffmpeg',
                ['-v', 'error', ...args, '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
                { maxBuffer: 8 * 1024 * 1024 },
              );
              decodes[mode] = {
                count: b.length / 8,
                peaks: peaks(
                  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
                ),
              };
            }
            const browser = await page.evaluate(
              async ({ bytes, rate }) => {
                const c = new globalThis.OfflineAudioContext(2, 1, rate),
                  b = await c.decodeAudioData(new Uint8Array(bytes).buffer);
                return {
                  count: b.length,
                  pcm: Array.from({ length: b.length }, (_, i) => [
                    b.getChannelData(0)[i],
                    b.getChannelData(1)[i],
                  ]).flat(),
                };
              },
              { bytes: Array.from(await readFile(file)), rate },
            );
            decodes.browser = { count: browser.count, peaks: peaks(browser.pcm) };
            return {
              startPts: stream.start_pts,
              durationSamples: stream.duration_ts,
              initialPadding: stream.initial_padding,
              firstPacket: probe.packets[0],
              lastPacket: probe.packets.at(-1),
              packetCount: probe.packets.length,
              decodes,
            };
          }
          const candidateDetail = await inspect(file),
            nativeControl = await inspect(controlFile);
          // Proposed timeline renderer semantics, separate from the strict raw-decoder gate.
          // Intersect timestamped decoded blocks with the declared half-open input interval.
          // Missing/overlapping coverage is an error, never filled or silently discarded.
          const decodedFrames = JSON.parse(
            execFileSync('ffprobe', [
              '-v',
              'error',
              '-select_streams',
              'a:0',
              '-show_frames',
              '-of',
              'json',
              file,
            ]),
          ).frames;
          const start = Math.round(origin * rate),
            end = start + count,
            presented = [];
          let consumed = 0,
            cursor = start;
          for (const frame of decodedFrames) {
            const lo = Math.max(start, frame.pts),
              hi = Math.min(end, frame.pts + frame.nb_samples);
            if (hi > lo) {
              assert.equal(lo, cursor, 'decoded coverage gap/overlap');
              for (let sample = lo; sample < hi; sample++) {
                const offset = (consumed + sample - frame.pts) * 2;
                presented.push(nativeSamples[offset], nativeSamples[offset + 1]);
              }
              cursor = hi;
            }
            consumed += frame.nb_samples;
          }
          assert.equal(consumed, ffmpegFrames);
          assert.equal(cursor, end);
          assert.equal(presented.length / 2, count);
          const presentation = {
            status: 'PASS',
            count: presented.length / 2,
            peaks: peaks(presented),
            semantics: 'explicit timestamped intersection; not raw decoder count',
          };
          assert(
            presentation.peaks.every(
              (p, i) => Math.abs(p.peak - expectedPeaks[i]) <= 2 && p.value > 0.01,
            ),
          );
          const checks = {
            avSync: avSync?.pass ?? true,
            waveformAligned,
            browserFrameCount: data.browserFrames === count,
            ffmpegFrameCount: ffmpegFrames === count,
            rate: data.browserRate === rate && Number(audio.sample_rate) === rate,
            channels: data.browserChannels === 2,
            origin: Math.abs(Number(audio.start_time) - origin) <= 1 / rate,
          };
          const result = {
            name,
            status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
            count,
            rate,
            origin,
            browserFrames: data.browserFrames,
            ffmpegFrames,
            avSync,
            nativePeaks,
            browserPeaks,
            rawPackets: data.rawPackets,
            presentation,
            timingEvidence: data.timingEvidence,
            candidateDetail,
            nativeControl,
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

function correctMetadata(buffer, { rate, count, origin, rawPackets }) {
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer),
    boxes = [];
  function walk(start, end, track = null) {
    for (let p = start; p < end; ) {
      const n = view.getUint32(p),
        type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (n < 8 || p + n > end) throw Error('invalid generated box');
      const owner = type === 'trak' ? p : track;
      boxes.push({ p, type, n, track: owner });
      if (['moov', 'trak', 'mdia', 'edts'].includes(type)) walk(p + 8, p + n, owner);
      p += n;
    }
  }
  walk(0, buffer.byteLength);
  function one(type, track = null) {
    const found = boxes.filter((b) => b.type === type && b.track === track);
    if (found.length !== 1 || view.getUint8(found[0].p + 8) !== 0)
      throw Error('unsupported generated ' + type);
    return found[0].p;
  }
  const mdat = boxes.find((b) => b.type === 'mdat');
  if (!mdat) throw Error('missing generated media');
  const originalMedia = bytes.slice(mdat.p, mdat.p + mdat.n);
  const tracks = boxes.filter((b) => b.type === 'trak'),
    audioTrack = tracks.find((t) => {
      const h = one('hdlr', t.p);
      return String.fromCharCode(...bytes.subarray(h + 16, h + 20)) === 'soun';
    });
  if (!audioTrack || tracks.length !== (count > 1024 ? 2 : 1))
    throw Error('unexpected generated tracks');
  const mvhd = one('mvhd'),
    oldMovieRate = view.getUint32(mvhd + 20),
    originSamples = Math.round(origin * rate),
    delay = originSamples - rawPackets[0].pts;
  if (delay !== 1024 || view.getUint32(one('mdhd', audioTrack.p) + 20) !== rate)
    throw Error('unexpected encoder timing');
  // Keep coded access units, track timebases and stts intact. Change movie timebase
  // to sample units; rescale every movie-unit duration including the video edits.
  view.setUint32(mvhd + 20, rate);
  view.setUint32(mvhd + 24, originSamples + count);
  for (const t of tracks) {
    const tkhd = one('tkhd', t.p),
      hasEdits = boxes.some((b) => b.type === 'elst' && b.track === t.p),
      elst = hasEdits ? one('elst', t.p) : null,
      entries = hasEdits ? view.getUint32(elst + 12) : 0;
    if (!hasEdits && (t.p === audioTrack.p || origin !== 0)) throw Error('missing expected edit');
    view.setUint32(tkhd + 28, Math.round((view.getUint32(tkhd + 28) * rate) / oldMovieRate));
    for (let i = 0; i < entries; i++) {
      const at = elst + 16 + i * 12;
      view.setUint32(at, Math.round((view.getUint32(at) * rate) / oldMovieRate));
    }
    if (t.p === audioTrack.p) {
      if (entries !== (origin > 0 ? 2 : 1)) throw Error('unexpected audio edit layout');
      view.setUint32(tkhd + 28, originSamples + count);
      let entry = elst + 16;
      if (entries === 2) {
        view.setUint32(entry, originSamples);
        view.setInt32(entry + 4, -1);
        entry += 12;
      }
      view.setUint32(entry, count);
      view.setInt32(entry + 4, delay);
    }
  }
  // Assert metadata independently of consumer behavior. Never slice decoded PCM.
  const elst = one('elst', audioTrack.p),
    n = view.getUint32(elst + 12),
    last = elst + 16 + (n - 1) * 12;
  if (view.getUint32(last) !== count || view.getInt32(last + 4) !== delay)
    throw Error('edit readback mismatch');
  if (!originalMedia.every((v, i) => v === bytes[mdat.p + i])) throw Error('coded media changed');
  globalThis.timingEvidence = {
    compositionOriginSamples: originSamples,
    validInputSamples: count,
    rawFirstPts: rawPackets[0].pts,
    measuredHeadDelay: delay,
    tailPadding: rawPackets.reduce((n, p) => n + p.duration, 0) - delay - count,
    movieTimescale: rate,
    editMediaTime: view.getInt32(last + 4),
    editDuration: view.getUint32(last),
    codedMediaUnchanged: true,
  };
  return buffer;
}
