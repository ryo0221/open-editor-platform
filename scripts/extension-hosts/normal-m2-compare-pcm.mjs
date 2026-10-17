/** Compare actual normal Host outputs, supplementing both independent media oracles. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
const [jsDir, wasmDir, destination] = process.argv.slice(2);
const load = async (dir) => JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'));
const [js, wasm] = await Promise.all([load(jsDir), load(wasmDir)]);
assert.equal(js.state, 'PASS');
assert.equal(wasm.state, 'PASS');
assert.equal(js.pcm.mode, 'js');
assert.equal(wasm.pcm.mode, 'wasm');
assert.equal(js.code, wasm.code);
assert.equal(js.browser, wasm.browser);
assert.deepEqual(js.hashes, wasm.hashes);
// Independent imports allocate UUIDs: normalize only sources and derived clip/link IDs.
const canonical = (native) => {
  const ids = native.sources.map((s, i) => [s.id, `source-${i}`]);
  return JSON.parse(
    JSON.stringify(native, (_, value) => {
      if (typeof value !== 'string') return value;
      for (const [id, stable] of ids)
        if (value === id || value.startsWith(id + ':')) return stable + value.slice(id.length);
      return value;
    }),
  );
};
assert.deepEqual(canonical(js.pcm.native), canonical(wasm.pcm.native));
const chunks = (p) =>
  p.pcm.encoded.chunkEvidence.map(({ first, end, hash }) => ({ first, end, hash }));
assert(chunks(js).length > 0);
assert.deepEqual(chunks(js), chunks(wasm));
const packets = (dir) =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_packets',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        'packet=pts,dts,duration,size,flags,data_hash',
        '-of',
        'json',
        path.join(dir, 'reopened.mp4'),
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ),
  ).packets;
const audio = packets(jsDir);
assert(audio.length > 0);
assert.deepEqual(audio, packets(wasmDir));
await writeFile(
  destination,
  JSON.stringify(
    {
      state: 'PASS',
      code: js.code,
      browser: js.browser,
      chunks: chunks(js).length,
      packets: audio.length,
      scope:
        'Normal Host pre-encode PCM and scheduled preview input hashes, plus AAC packet bytes/timing; not audio-device output.',
    },
    null,
    2,
  ),
);
