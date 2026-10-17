import { productBuild } from '../product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, one, two, out] = process.argv.slice(2);
await mkdir(out);
for (const [name, channels] of [
  ['music', 1],
  ['stereo', 2],
])
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=44100:duration=4.5',
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
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/m2/editing-ui.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const html = await readFile('packages/video-metadata/host-media/m2/editing-ui.html');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(q.url === '/run.js' ? built.outputFiles[0].contents : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const proofs = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => globalThis.videoV2Ready);
    const native = async () => JSON.parse(await page.locator('#native').textContent());
    const click = async (name) => {
      await page.getByRole('button', { name, exact: true }).click();
    };
    const trim = async (id, start, end) => {
      await page.locator('#selected').selectOption(id);
      await page.locator('#trim-start').fill(start);
      await page.locator('#trim-end').fill(end);
      await click('Trim selected clip');
    };
    const resize = async () => {
      await page.locator('#duration').fill('4');
      await click('Resize sequence');
    };
    const importFile = async (file) => {
      await page.locator('#import').setInputFiles(file);
      await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
    };
    await importFile(one);
    let v = await native();
    const first = v.sequence.clips.map((c) => c.id);
    for (const id of first) await trim(id, '0', '2');
    await page.locator('#duration').fill('2');
    await click('Resize sequence');
    await importFile(two);
    v = await native();
    const second = v.sequence.clips.filter((c) => !first.includes(c.id)).map((c) => c.id);
    for (const id of second) await trim(id, '2', '4');
    await resize();
    await page.locator('#import-kind').selectOption('aac-mono-v2');
    await page.locator('#audio-start').fill('1/1000');
    await importFile(path.join(out, 'music.m4a'));
    v = await native();
    const music = v.sequence.clips.find((c) => c.trackId === 'music').id;
    await trim(music, '1/1000', '3999/1000');
    await resize();
    await page.locator('#selected').selectOption(music);
    await page.locator('#gain').fill('20');
    await click('Set volume');
    const gained = await native();
    await click('Undo');
    const beforeEmpty = await native(),
      revision = await page.locator('main').getAttribute('data-revision');
    await page.locator('#gain').fill('');
    await click('Set volume');
    await expect(page.locator('#status')).toContainText('volume');
    assert.deepEqual(await native(), beforeEmpty, 'Empty volume changed native');
    assert.equal(
      await page.locator('main').getAttribute('data-revision'),
      revision,
      'Empty volume changed revision',
    );
    assert.equal(await page.locator('#gain').inputValue(), '', 'Invalid input was replaced');
    await click('Redo');
    assert.deepEqual(await native(), gained, 'Empty volume lost Redo');
    await page.locator('#gain').fill('0');
    await click('Set volume');
    assert.equal(
      (await native()).sequence.clips.find((c) => c.id === music).gain,
      0,
      'Explicit zero refused',
    );
    await click('Undo');
    assert.deepEqual(await native(), gained);
    await page.locator('#fade-in').fill('1/2');
    await page.locator('#fade-out').fill('1/2');
    await click('Set fades');
    const edited = await native();
    assert.equal(edited.sequence.clips.find((c) => c.id === music).gain, 0.2);
    assert.deepEqual(edited.sequence.clips.find((c) => c.id === music).fade.in, {
      value: 1,
      timescale: 2,
    });
    await click('Undo');
    const undone = await native();
    assert.notDeepEqual(undone, edited);
    await page.locator('#gain').fill('101');
    await click('Set volume');
    assert.deepEqual(await native(), undone);
    await page.locator('#import').setInputFiles(path.join(out, 'stereo.m4a'));
    await expect(page.locator('#status')).toContainText('mono', { timeout: 120000 });
    assert.deepEqual(await native(), undone);
    await click('Redo');
    assert.deepEqual(await native(), edited);
    await page.locator('#preview-frame').fill('50');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 120000 });
    assert.deepEqual(await page.locator('canvas').evaluate((c) => [c.width, c.height]), [270, 480]);
    await expect(
      page.getByRole('button', { name: 'Save portable project', exact: true }),
    ).toBeDisabled();
    await page.locator('#preview-frame').fill('0');
    await click('Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 180000 });
    const delivery = page.waitForEvent('download', { timeout: 180000 });
    const [, download] = await Promise.all([click('Export MP4'), delivery]);
    await download.saveAs(path.join(out, `edited-${width}.mp4`));
    await expect(page.locator('#status')).toHaveText('Export complete', { timeout: 180000 });
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      path.join(out, `edited-${width}.mp4`),
      '-f',
      'null',
      '-',
    ]);
    await page.screenshot({ path: path.join(out, `editing-${width}.png`), fullPage: true });
    assert(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
    );
    await page.evaluate(() => globalThis.closeVideoV2());
    assert.deepEqual(errors, []);
    proofs.push({
      width,
      native: edited,
      errors,
      invalidGainAtomic: true,
      stereoAtomic: true,
      redoPreserved: true,
    });
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  proofs,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({ state: result.state, code: result.code, widths: proofs.map((p) => p.width) }),
);
