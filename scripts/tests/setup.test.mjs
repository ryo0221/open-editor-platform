import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { downloadPinned } from '../lib/pinned-download.mjs';
import { inspectOfficeFonts, repositoryRoot } from '../office-fonts.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = { url: 'https://example.invalid/pinned', bytes: 4, sha256: sha('font') };
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'editor-setup-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const reply = (text, status = 200) => new globalThis.Response(text, { status });

test('a verified download is reused offline without changing its bytes', async (t) => {
  const root = await directory(t),
    path = join(root, 'font');
  assert.equal(await downloadPinned(pin, path, async () => reply('font')), 'downloaded');
  assert.equal(await readFile(path, 'utf8'), 'font');
  assert.equal(
    await downloadPinned(pin, path, () => assert.fail('valid cache accessed the network')),
    'cached',
  );
  assert.deepEqual(await readdir(root), ['font']);
});
test('a corrupt cache is rejected rather than silently overwritten', async (t) => {
  const root = await directory(t),
    path = join(root, 'font');
  await writeFile(path, 'bad!');
  await assert.rejects(
    downloadPinned(pin, path, () => assert.fail('corrupt cache retried')),
    /mismatch/,
  );
  assert.equal(await readFile(path, 'utf8'), 'bad!');
});
test('simultaneous verified downloads publish one complete cache file', async (t) => {
  const root = await directory(t),
    path = join(root, 'font');
  await Promise.all([
    downloadPinned(pin, path, async () => reply('font')),
    downloadPinned(pin, path, async () => reply('font')),
  ]);
  assert.equal(await readFile(path, 'utf8'), 'font');
  assert.deepEqual(await readdir(root), ['font']);
});
for (const [name, text, message] of [
  ['wrong checksum', 'bad!', /mismatch/],
  ['truncated file', 'fo', /mismatch/],
  ['oversized body', 'font-more', /exceeds/],
])
  test(`${name} cannot publish a partial download`, async (t) => {
    const root = await directory(t);
    await assert.rejects(
      downloadPinned(pin, join(root, 'font'), async () => reply(text)),
      message,
    );
    assert.deepEqual(await readdir(root), []);
  });
test('HTTP failure leaves no destination or partial file', async (t) => {
  const root = await directory(t);
  await assert.rejects(
    downloadPinned(pin, join(root, 'font'), async () => reply('no', 503)),
    /503/,
  );
  assert.deepEqual(await readdir(root), []);
});
test('interrupted response stream leaves no destination or partial file', async (t) => {
  const root = await directory(t);
  await assert.rejects(
    downloadPinned(pin, join(root, 'font'), async () => ({
      ok: true,
      body: (async function* () {
        yield new globalThis.TextEncoder().encode('fo');
        throw Error('interrupted');
      })(),
    })),
    /interrupted/,
  );
  assert.deepEqual(await readdir(root), []);
});
async function manifests(root) {
  for (const [name, prefix] of [
    ['manifest.json', 'normal'],
    ['mono-manifest.json', 'mono'],
  ]) {
    const faces = ['regular', 'bold'].map((weight) => ({
      file: `${prefix}-${weight}.otf`,
      sha256: sha(`${prefix}-${weight}`),
    }));
    await writeFile(join(root, name), JSON.stringify({ faces }));
    for (const face of faces) await writeFile(join(root, face.file), face.file.slice(0, -4));
  }
}
test('preflight verifies proportional and monospace Regular/Bold independently', async (t) => {
  const root = await directory(t);
  await manifests(root);
  assert.equal((await inspectOfficeFonts(root)).faces.length, 4);
  await writeFile(join(root, 'mono-bold.otf'), 'corrupt');
  await assert.rejects(inspectOfficeFonts(root, true), /SHA-256 mismatch.*mono-bold/);
});
test('missing font preflight exits with an actionable fetch command', async (t) => {
  const root = await directory(t);
  await manifests(root);
  await rm(join(root, 'normal-regular.otf'));
  assert.deepEqual(
    (await inspectOfficeFonts(root, true)).missing.map((face) => face.file),
    ['normal-regular.otf'],
  );
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, 'scripts/check-office-fonts.mjs'), root],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /normal-regular.otf.*npm run fonts:fetch/);
});
test('an empty manifest cannot claim that all four fonts were verified', async (t) => {
  const root = await directory(t);
  await manifests(root);
  await writeFile(join(root, 'mono-manifest.json'), JSON.stringify({ faces: [] }));
  await assert.rejects(inspectOfficeFonts(root), /exactly two faces/);
});
