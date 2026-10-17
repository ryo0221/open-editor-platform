import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [buildRoot, out] = process.argv.slice(2);
assert(buildRoot && out);
await mkdir(out);
const fixtures = [];
for (const [ten, noEdit, explicitDuration] of [
  [false, false],
  [true, false],
  [true, true],
  [true, false, true],
]) {
  const name = ten
      ? 'hevc10-hlg-vfr' + (noEdit ? '-no-edit' : explicitDuration ? '-explicit-duration' : '')
      : 'hevc8',
    file = path.join(out, name + '.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=96x64:rate=25',
      '-vf',
      ten ? 'format=yuv420p10le,setpts=PTS+floor(N/3)' : 'format=yuv420p',
      '-frames:v',
      '12',
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx265',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error' +
        (ten ? ':colorprim=9:transfer=18:colormatrix=9' : ''),
      '-tag:v',
      'hvc1',
      ...(ten
        ? ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']
        : []),
      ...(noEdit ? ['-use_editlist', '0'] : []),
      // setts defaults TS to DTS; preserve PTS explicitly for reordered frames.
      ...(explicitDuration ? ['-bsf:v', 'setts=pts=PTS:dts=DTS:duration=1/(25*TB)'] : []),
      file,
    ],
    { stdio: 'pipe' },
  );
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_streams',
      '-of',
      'json',
      file,
    ]),
  );
  const md5 = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-fps_mode',
    'passthrough',
    '-f',
    'framemd5',
    '-',
  ])
    .toString()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1).trim());
  const packets = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-of',
      'json',
      file,
    ]),
  ).packets;
  await writeFile(
    path.join(out, name + '.timeline.json'),
    JSON.stringify({ streams: probe.streams, packets }, null, 2),
  );
  if (explicitDuration) {
    assert.equal(Number(probe.streams[0].duration), 0.6);
    assert.equal(packets.filter((p) => p.flags.includes('D')).length, 0);
    assert(
      packets.some((p, i) => i && p.pts < packets[i - 1].pts),
      'fixture must exercise reordering',
    );
    assert.deepEqual(
      probe.frames.map((f) => f.best_effort_timestamp),
      [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((n) => n * 512),
    );
  }
  fixtures.push({ name, file, probe, md5 });
}
const worker = `import factory from '/decode.mjs';
onmessage=async({data})=>{let m;try{m=await factory();m.input=new Uint8Array(data.bytes);m.frames=[];m.events=[];m._set_defer_receive(data.defer?1:0);let code=m._open_input(m.input.length,data.limit??1000),steps=0;if(code===0){do{code=m._decode_step();steps++;if(data.cancel&&steps===2){m._close_input();code=m._decode_step();break;}}while(code===0&&steps<1002);}m._close_input();postMessage({code,frames:m.frames,steps,events:m.events});}catch(e){m?._close_input();postMessage({error:String(e)});}};`;
const server = createServer(async (req, res) => {
  try {
    const name = req.url.slice(1);
    if (name === 'worker.mjs') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(worker);
    } else if (['decode.mjs', 'decode.wasm'].includes(name)) {
      res.setHeader('Content-Type', name.endsWith('wasm') ? 'application/wasm' : 'text/javascript');
      res.end(await readFile(path.join(buildRoot, name)));
    } else res.end('<!doctype html>');
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage(),
  results = [];
await page.goto(`http://127.0.0.1:${server.address().port}`);
async function run(bytes, options = {}) {
  return page.evaluate(
    (data) =>
      new Promise((resolve, reject) => {
        const worker = new globalThis.Worker('/worker.mjs', { type: 'module' });
        worker.onmessage = (e) => {
          worker.terminate();
          resolve(e.data);
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(Error(e.message));
        };
        worker.postMessage(data);
      }),
    { bytes: Array.from(bytes), ...options },
  );
}
try {
  for (const fixture of fixtures)
    for (const mode of [
      'decode',
      'cancel',
      'packet-limit',
      ...(fixture.name.endsWith('explicit-duration') ? ['deferred-receive'] : []),
    ]) {
      let detail;
      try {
        detail = await run(
          await readFile(fixture.file),
          mode === 'cancel'
            ? { cancel: true }
            : mode === 'packet-limit'
              ? { limit: 1 }
              : mode === 'deferred-receive'
                ? { defer: true }
                : {},
        );
        assert(!detail.error, detail.error);
        if (mode === 'cancel') assert.equal(detail.code, -108);
        else if (mode === 'packet-limit') assert.equal(detail.code, -109);
        else {
          assert.equal(detail.code, 1);
          assert.deepEqual(detail.events.slice(-2), ['flush-sent', 'decoder-eof']);
          if (mode === 'deferred-receive') {
            assert(detail.events.includes('send-eagain'));
            assert.equal(
              detail.events.filter((e) => e === 'send-eagain').length,
              detail.events.filter((e) => e === 'packet-resent').length,
            );
          }
          assert.equal(detail.frames.length, 12);
          assert.deepEqual(
            detail.frames.map((f) => f.md5),
            fixture.md5,
          );
          for (let i = 0; i < 12; i++) {
            const actual = detail.frames[i],
              expected = fixture.probe.frames[i];
            assert.equal(actual.pts, expected.best_effort_timestamp);
            assert.equal(actual.pixel, expected.pix_fmt);
            assert.equal(actual.width, 96);
            assert.equal(actual.height, 64);
            if (fixture.name.includes('hlg')) {
              assert.equal(actual.primaries, 9);
              assert.equal(actual.transfer, 18);
              assert.equal(actual.matrix, 9);
            }
          }
        }
        results.push({ name: fixture.name, mode, status: 'PASS', detail });
      } catch (error) {
        results.push({ name: fixture.name, mode, status: 'FAIL', error: String(error), detail });
      }
      console.log(fixture.name, mode, results.at(-1).status);
    }
  const malformed = await run(new Uint8Array(16));
  assert(malformed.code < 0 && !malformed.error);
  results.push({ name: 'malformed', status: 'PASS', detail: malformed });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
