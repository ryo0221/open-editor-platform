import { verifyActualOutput } from '../../packages/video-metadata/host-media/m2/actual-output-oracle.mjs';
import { build } from 'esbuild';
import { auditPlayback, auditExport, auditStartup } from './normal-m2-pcm-audit.mjs';
// Normal production Host acceptance; raw evidence remains outside Git.
import { chromium, expect } from '@playwright/test';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [out, pcmMode] = process.argv.slice(2);
assert(out && path.resolve(out).startsWith('/tmp/'));
const code = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
await mkdir(out);
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://local').pathname;
    if (name === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    assert(!name.includes('..'));
    res.setHeader(
      'content-type',
      name.endsWith('.js')
        ? 'application/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : name.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html',
    );
    res.end(await readFile(path.join(process.cwd(), 'dist', name === '/' ? 'index.html' : name)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [],
  files = [
    '/tmp/issue76-normal-video-inputs/D06_V_indoor_move_0001.mov',
    '/tmp/issue76-normal-video-inputs/D06_V_indoor_move_0002.mov',
    path.join(out, 'music.m4a'),
  ];
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=44100:duration=4.5',
  '-ac',
  '1',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  files[2],
]);
const sha = (file) => execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0];
const hashes = files.map(sha);
assert.equal(hashes[0], '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4');
assert.equal(hashes[1], '2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022');
const filesByHash = new Map(hashes.map((h, i) => [h, files[i]]));
let context, page, result, stage;
const startups = [];
const click = (name) => page.getByRole('button', { name, exact: true }).click();
const native = async () => JSON.parse(await page.locator('#native').textContent());
const inspect = () => page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
async function open() {
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(origin + '/?privateEditor=video-v2-review');
  await expect(page.locator('#import')).toBeVisible();
  if (pcmMode) startups.push(await auditStartup(page, pcmMode));
}
async function download(name, button = 'Save portable project') {
  const pending = page.waitForEvent('download', { timeout: 180000 });
  await click(button);
  const file = path.join(out, name);
  await (await pending).saveAs(file);
  return file;
}
async function trim(id, start, end) {
  await page.locator('#selected').selectOption(id);
  await page.locator('#trim-start').fill(start);
  await page.locator('#trim-end').fill(end);
  await click('Trim selected clip');
}
async function resize(value) {
  await page.locator('#duration').fill(value);
  await click('Resize sequence');
}
async function original(file) {
  await page.locator('#import').setInputFiles(file);
  await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 180000 });
}
try {
  stage = 'full-original-save';
  await open();
  await original(files[0]);
  const first = (await native()).sequence.clips.map((c) => c.id);
  for (const id of first) await trim(id, '0', '2');
  await resize('2');
  await original(files[1]);
  for (const c of (await native()).sequence.clips.filter((c) => !first.includes(c.id)))
    await trim(c.id, '2', '4');
  await resize('4');
  await page.locator('#import-kind').selectOption('aac-mono-v2');
  await page.locator('#audio-start').fill('1/1000');
  await original(files[2]);
  const music = (await native()).sequence.clips.find((c) => c.trackId === 'music').id;
  await trim(music, '1/1000', '3999/1000');
  await resize('4');
  await page.locator('#selected').selectOption(music);
  await page.locator('#gain').fill('20');
  await click('Set volume');
  await page.locator('#fade-in').fill('1/2');
  await page.locator('#fade-out').fill('1/2');
  await click('Set fades');
  const content = await native(),
    archive = await download('originals-v1.zip');
  const bytes = (await stat(archive)).size;
  assert(bytes > 256 * 1024 ** 2 && bytes <= 512 * 1024 ** 2);
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const before = await inspect();
  assert.equal(before.versions.versions.length, 1);
  assert.equal(before.capacity.reservations.length, 0);
  await click('Return to Library');
  await context.tracing.stop({ path: path.join(out, 'original.zip') });
  await context.close();
  stage = 'fresh-origin-reopen-play-export';
  await open();
  await page
    .getByText('Open portable Video M2 project ', { exact: false })
    .locator('input')
    .setInputFiles(archive);
  await expect.poll(native, { timeout: 180000 }).toEqual(content);
  let pcm;
  if (pcmMode) pcm = await auditPlayback(page, content, filesByHash, pcmMode);
  else {
    await click('Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 180000 });
  }
  const output = await download('reopened.mp4', 'Export MP4');
  await expect(page.locator('#status')).toHaveText('Export complete');
  if (pcm) pcm = await auditExport(page, pcm);
  const oracle = verifyActualOutput(content, filesByHash, output, {
    width: 1080,
    height: 1920,
    background: '#000000',
  });
  await writeFile(path.join(out, 'oracle.json'), JSON.stringify(oracle, null, 2));
  stage = 'history-and-logical-refusal';
  await page.locator('#selected').selectOption(music);
  await page.locator('#fade-in').fill('1/4');
  await page.locator('#fade-out').fill('1/4');
  await click('Set fades');
  const second = await download('originals-v2.zip');
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const history = await inspect();
  assert.equal(history.versions.versions.length, 2);
  assert.deepEqual(history.versions.versions[0], before.versions.versions[0]);
  // Test-only competing no-write reservation through the existing capacity API.
  const qa = await build({
    stdin: {
      contents: `import {TotalCapacity} from './packages/video-metadata/file-backed-storage/integration/capacity';import {validationPolicy} from './packages/video-metadata/host-media/m2/capacity-validation-policy.mjs';globalThis.reserveQA=async()=>{const c=await TotalCapacity.open(validationPolicy),u=await c.inspect(),id='normal-validation-test:competing',p='normal-validation-test/preparation-'+globalThis.crypto.randomUUID();await c.reserve(id,p,Math.floor(u.availableBytes/2));globalThis.releaseQA=async()=>{await c.settle(id,p,'no-write');c.close();};};`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  await page.addScriptTag({ content: qa.outputFiles[0].text });
  await page.evaluate(() => globalThis.reserveQA());
  await page.locator('#gain').fill('15');
  await click('Set volume');
  const retained = await inspect();
  await click('Save portable project');
  await expect(page.locator('#status')).toContainText('aborted-before-write', { timeout: 180000 });
  const refused = await inspect();
  assert.deepEqual(refused.native, retained.native);
  assert.deepEqual(refused.versions, retained.versions);
  assert.equal(refused.transition.unresolvedSave, false);
  assert.equal(refused.capacity.reservations.length, 1);
  await page.evaluate(() => globalThis.releaseQA());
  await download('originals-v3.zip');
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const retried = await inspect();
  assert.equal(retried.versions.versions.length, 3);
  assert.equal(retried.capacity.reservations.length, 0);
  assert.deepEqual(retried.media, { building: 0, reads: 0, files: 0, bytes: 0 });
  assert.deepEqual(retried.versions.versions.slice(0, 2), history.versions.versions);
  await page.screenshot({ path: path.join(out, 'final.png'), fullPage: true });
  await click('Return to Library');
  await click('New Video project (private)');
  await expect(page.locator('#duration')).toBeVisible();
  await click('Return to Library');
  assert.deepEqual(files.map(sha), hashes);
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    code,
    hashes,
    archiveBytes: bytes,
    archiveSha256: sha(archive),
    secondSha256: sha(second),
    before,
    history,
    refused,
    retried,
    oracle,
    pcm,
    startups,
    browser: browser.version(),
    errors,
    limitations: [
      'Dedicated controlled validation origin',
      'Logical capacity, not physical disk guarantee',
      'Desktop 1280; performance held',
    ],
  };
} catch (error) {
  result = { state: 'FAIL', code, stage, error: String(error), stack: error.stack, errors };
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await context?.tracing.stop({ path: path.join(out, 'workflow.zip') }).catch(() => {});
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
}
