/** Compare actual-check outputs; complements, never replaces its independent oracle. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [jsDir, wasmDir, destination] = process.argv.slice(2);
assert.ok(jsDir && wasmDir && destination, 'Usage: compare-modes.mjs jsDir wasmDir output.json');
const load = async (dir) => JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'));
const [js, wasm] = await Promise.all([load(jsDir), load(wasmDir)]);
assert.equal(js.state, 'PASS');
assert.equal(wasm.state, 'PASS');
assert.equal(js.mode, 'js');
assert.equal(wasm.mode, 'wasm');
assert.equal(js.code, wasm.code);
assert.equal(js.workingTree, '');
assert.equal(wasm.workingTree, '');
assert.equal(js.browser, wasm.browser);
assert.deepEqual(js.hashes, wasm.hashes);
assert.deepEqual(
  js.proofs.map((p) => p.kind),
  ['two-direct', 'single-reopened'],
);
assert.deepEqual(
  wasm.proofs.map((p) => p.kind),
  js.proofs.map((p) => p.kind),
);
const packets = (dir, kind) =>
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
        path.join(dir, kind + '.mp4'),
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ),
  ).packets;
// Independent imports allocate UUIDs. Normalize only source IDs and their derived
// clip/link IDs, preserving identity relationships and every media/edit field.
const canonicalNative = (native) => {
  const ids = native.sources.map((source, index) => [source.id, `source-${index}`]);
  return JSON.parse(
    JSON.stringify(native, (_, value) => {
      if (typeof value !== 'string') return value;
      for (const [id, stable] of ids) {
        if (value === id || value.startsWith(id + ':')) return stable + value.slice(id.length);
      }
      return value;
    }),
  );
};
const results = js.proofs.map((left, index) => {
  const right = wasm.proofs[index];
  assert.deepEqual(canonicalNative(left.native), canonicalNative(right.native));
  const chunks = (p) =>
    p.encodedEvidence.chunkEvidence.map(({ first, end, hash }) => ({ first, end, hash }));
  assert.equal(chunks(left).length, 100);
  assert.deepEqual(chunks(left), chunks(right));
  for (const proof of [left, right]) {
    assert.deepEqual(
      proof.playback.chunks.map(({ first, end, hash }) => ({ first, end, hash })),
      chunks(proof),
    );
    assert.ok(proof.oracle.audio && proof.oracle.pictures.length > 0);
    assert.equal(proof.backend.realmBytes, proof.backend.moduleBytes);
    for (const source of proof.encodedEvidence.pcmReader)
      assert.equal(source.backend.fallback, false);
  }
  for (const source of right.encodedEvidence.pcmReader) {
    assert.equal(source.backend.backend, 'wasm');
    assert.ok(source.backend.invocations > 0);
    assert.equal(source.backend.invocations, source.backend.completions);
  }
  const audio = packets(jsDir, left.kind);
  assert.equal(audio.length, 189);
  assert.deepEqual(audio, packets(wasmDir, right.kind));
  return { kind: left.kind, chunks: 100, packets: 189, state: 'PASS' };
});
const result = {
  state: 'PASS',
  code: js.code,
  engine: js.browser,
  results,
  scope:
    'Pre-encode PCM and scheduled preview input hashes; not audio-device output. AAC packet bytes/timing equality supplements independent FFmpeg oracle.',
};
await writeFile(destination, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
