/* global window */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import { metrics } from './metrics.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { signal } from './signal.mjs';
import { parse } from './metadata.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild'),
  { chromium } = require('playwright');
const root = process.argv[2];
const deps = process.argv[3];
if (!root || !deps) throw Error('Provide fresh output directory and isolated dependency directory');
// Refuse source drift; this experiment never patches or adopts the candidate.
const pins = {
  'package-lock.json': '36a13b1a10cd181f246dc3e5340799a1af3a7d992b06961d0034bb41dae28d42',
  'node_modules/mediabunny/dist/modules/src/media-source.js':
    '1c60a60034eff049d8ee1a973de7ef665bb8e648ee14854227150556e25f9088',
  'node_modules/mediabunny/dist/modules/src/output.js':
    '699dae1192ee789c32577a0cf2e9980d41845af4e66b8ba626e6ba87f9b511b3',
  'node_modules/mediabunny/dist/modules/src/matroska/matroska-muxer.js':
    '531ea55a6e46bb78ac6b9b52be76c95a57e21626d8422af3d6b427e21fcec049',
  'node_modules/mediabunny/dist/modules/src/matroska/matroska-demuxer.js':
    'bdbae8a5706fb5d2bc891ee58f8b016647436c0cb4f4a6b7d720e938296da2a4',
};
for (const [file, hash] of Object.entries(pins)) {
  if (
    createHash('sha256')
      .update(await readFile(`${deps}/${file}`))
      .digest('hex') !== hash
  )
    throw Error(`Candidate source drift: ${file}`);
}
await mkdir(root, { recursive: false });
await mkdir(root + '/results', { recursive: true });
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./browser.mjs', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  nodePaths: [deps + '/node_modules'],
});
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].text);
  } else if (req.url === '/') {
    res.end('<script src="/bundle.js"></script>');
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route('**/*', (route) =>
  route
    .request()
    .url()
    .startsWith(address + '/')
    ? route.continue()
    : route.abort(),
);
await page.goto(address);
await page.waitForFunction(() => typeof window.runFixture === 'function');

const rows = [];
try {
  for (const [n, rate] of [
    [1, 48000],
    [17, 48000],
    [648, 48000],
    [960, 48000],
    [961, 48000],
    [48000, 48000],
    [48123, 48000],
    [44100, 44100],
  ])
    for (const origin of [0, 0.125]) {
      const name = `n${n}-r${rate}-o${origin}`,
        av = n === 48000;
      try {
        const result = await page.evaluate(
          async ({ n, origin, av, rate }) => await window.runFixture(n, origin, av, rate),
          { n, origin, av, rate },
        );
        const bytes = Buffer.from(result.bytes),
          file = `${root}/results/${name}.webm`;
        await writeFile(file, bytes);
        const meta = parse(bytes),
          audio = meta.tracks.find((t) => t.codec === 'A_OPUS');
        const probe = JSON.parse(
          execFileSync(
            '/usr/bin/ffprobe',
            [
              '-v',
              'error',
              '-count_frames',
              '-show_streams',
              '-show_packets',
              '-show_frames',
              '-of',
              'json',
              file,
            ],
            { maxBuffer: 8 * 1024 * 1024 },
          ),
        );
        const raw = execFileSync(
          '/usr/bin/ffmpeg',
          [
            '-v',
            'error',
            '-i',
            file,
            '-map',
            '0:a:0',
            '-f',
            'f32le',
            '-acodec',
            'pcm_f32le',
            'pipe:1',
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        );
        await writeFile(`${root}/results/${name}-ffmpeg.f32`, raw);
        const decoded = Float32Array.from({ length: raw.length / 4 }, (_, i) =>
          raw.readFloatLE(i * 4),
        );
        const reference = signal((n * 48000) / rate),
          browserPcm = Float32Array.from(result.decoded);
        await writeFile(`${root}/results/${name}-browser.f32`, Buffer.from(browserPcm.buffer));
        const firstFfmpeg = probe.packets_and_frames?.find(
          (f) => f.type === 'frame' && f.media_type === 'audio',
        );
        const qualities = {
          browser: [0, 1].map((c) =>
            metrics(reference, browserPcm, c, result.frames[0]?.timestamp ?? NaN, origin),
          ),
          ffmpeg: [0, 1].map((c) =>
            metrics(reference, decoded, c, Number(firstFfmpeg?.pts_time), origin),
          ),
        };
        const stream = probe.streams.find((s) => s.codec_type === 'audio');
        const countPass =
          decoded.length === reference.length &&
          browserPcm.length === reference.length &&
          Number(stream?.sample_rate) === 48000 &&
          stream.channels === 2 &&
          result.frames.every((f) => f.rate === 48000 && f.channels === 2);
        const delayPass =
          !!audio.codecDelay &&
          audio.codecDelay.value * 48000n === audio.opus.preSkip * 1000000000n;
        const video = probe.streams.find((s) => s.codec_type === 'video');
        const frames =
          probe.packets_and_frames?.filter((f) => f.type === 'frame' && f.media_type === 'video') ??
          [];
        const videoPass =
          !av ||
          (Number(video?.nb_read_frames) === 25 &&
            frames.length === 25 &&
            frames.every(
              (f, i) =>
                /^-?\d+\.\d{6}$/.test(f.pts_time) &&
                BigInt(f.pts_time.replace('.', '')) === BigInt(origin * 1e6 + i * 40000),
            ));
        const pass =
          countPass &&
          delayPass &&
          videoPass &&
          Object.values(qualities)
            .flat()
            .every((q) => q.pass);
        const row = {
          name,
          n,
          rate,
          expectedSamples: reference.length / 2,
          origin,
          av,
          bytesHash: createHash('sha256').update(bytes).digest('hex'),
          browserSamples: browserPcm.length / 2,
          ffmpegSamples: decoded.length / 2,
          countPass,
          delayPass,
          videoPass,
          qualities,
          pass,
        };
        rows.push(row);
        await writeFile(
          `${root}/results/${name}.json`,
          JSON.stringify(
            { row, meta, probe, frames: result.frames, packets: result.packets },
            (_, v) => (typeof v === 'bigint' ? String(v) : v),
            2,
          ),
        );
      } catch (error) {
        rows.push({ name, n, origin, pass: false, error: String(error) });
      }
    }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
const report = {
  pins,
  browser: execFileSync('/usr/bin/chromium', ['--version'], { encoding: 'utf8' }).trim(),
  mediabunny: '1.61.3',
  ffmpeg: execFileSync('/usr/bin/ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  errors,
  rows,
};
await writeFile(root + '/results/report.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      rows: rows.map(
        ({
          name,
          browserSamples,
          ffmpegSamples,
          countPass,
          delayPass,
          videoPass,
          pass,
          error,
        }) => ({
          name,
          browserSamples,
          ffmpegSamples,
          countPass,
          delayPass,
          videoPass,
          pass,
          error,
        }),
      ),
      errors,
    },
    null,
    2,
  ),
);
process.exitCode = rows.every((r) => r.pass) && !errors.length ? 0 : 2;
