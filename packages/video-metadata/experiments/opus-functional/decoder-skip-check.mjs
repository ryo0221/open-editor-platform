/** Isolated decoder diagnostic; no production backend selection or expected-length trimming. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import { signal } from './signal.mjs';
import { metrics } from './metrics.mjs';
const [baseline, patched, fixtures, out] = process.argv.slice(2);
assert(baseline && patched && fixtures && out && path.resolve(out).startsWith('/tmp/'));
await mkdir(out);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cases = [1, 17, 648, 960, 961, 48000, 48123].map((n) => ({ n, rate: 48000 }));
cases.push({ n: 44100, rate: 44100 });
const evidence = {
  claim:
    'Finite audio decoder diagnostic only; original browser/video/product gates are not replaced.',
  binaries: {},
  rows: [],
};
for (const [label, directory] of [
  ['baseline', baseline],
  ['patched', patched],
]) {
  evidence.binaries[label] = {};
  for (const program of ['ffmpeg', 'ffprobe']) {
    const file = path.resolve(directory, program);
    const version = execFileSync(file, ['-version'], { encoding: 'utf8' });
    assert(
      new RegExp('^' + program + ' version n?7\\.1\\.5(?:-dirty)? ').test(version),
      'Exact diagnostic version required',
    );
    evidence.binaries[label][program] = { sha256: hash(await readFile(file)), version };
  }
}
for (const { n, rate } of cases)
  for (const origin of [0, 0.125]) {
    const name = `n${n}-r${rate}-o${origin}`,
      file = path.resolve(fixtures, name + '.webm');
    const bytes = await readFile(file);
    assert(bytes.length <= 2 * 1024 * 1024, 'Finite input budget');
    const expectedSamples = Math.round((n * 48000) / rate),
      reference = signal(expectedSamples);
    const row = { name, inputSha256: hash(bytes), expectedSamples, origin, decoders: {} };
    for (const [label, directory] of [
      ['baseline', baseline],
      ['patched', patched],
    ]) {
      const output = path.resolve(out, name + '-' + label + '.f32');
      // The decoder receives only the real file. No target count, timestamp override,
      // padding, atrim or codec substitution is provided.
      execFileSync(
        path.resolve(directory, 'ffmpeg'),
        ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', output],
        { maxBuffer: 2 * 1024 * 1024 },
      );
      const pcm = await readFile(output);
      assert.equal(pcm.length % 8, 0);
      const decoded = Float32Array.from({ length: pcm.length / 4 }, (_, i) =>
        pcm.readFloatLE(i * 4),
      );
      const probe = JSON.parse(
        execFileSync(
          path.resolve(directory, 'ffprobe'),
          [
            '-v',
            'error',
            '-select_streams',
            'a',
            '-show_frames',
            '-show_entries',
            'frame=pts_time,nb_samples',
            '-of',
            'json',
            file,
          ],
          { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
        ),
      );
      assert(probe.frames.length > 0);
      const qualities = [0, 1].map((c) =>
        metrics(reference, decoded, c, Number(probe.frames[0].pts_time), origin),
      );
      row.decoders[label] = {
        frames: decoded.length / 2,
        first: probe.frames[0],
        last: probe.frames.at(-1),
        qualities,
        pass: qualities.every((q) => q.pass),
      };
    }
    evidence.rows.push(row);
  }
await writeFile(path.join(out, 'report.json'), JSON.stringify(evidence, null, 2));
const summary = Object.fromEntries(
  ['baseline', 'patched'].map((k) => [
    k,
    {
      pass: evidence.rows.filter((r) => r.decoders[k].pass).length,
      fail: evidence.rows.filter((r) => !r.decoders[k].pass).length,
    },
  ]),
);
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
// Remaining quality failures stay failures, even when the timing correction succeeds.
if (evidence.rows.some((r) => !r.decoders.patched.pass)) process.exitCode = 2;
