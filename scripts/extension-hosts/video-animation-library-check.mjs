import { exerciseDissolveScenario, verifyDissolveOutput } from './video-dissolve-scenario.mjs';
import {
  exerciseTitleScenario,
  exerciseCaptionScenario,
  verifyTitleOutput,
} from './video-title-scenario.mjs';
// Real normal Library + private Video runtime. Local functional output only.
import {
  exerciseEditingScenario,
  verifyEditingAudio,
  prepareEditingImages,
  verifyEditingImages,
  verifyEditingComposite,
} from './video-editing-scenario.mjs';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [out, legacyV1, legacyV2, mediaDirectory, imageSize = '256'] = process.argv.slice(2);
assert(['256', '4096'].includes(imageSize));
assert(
  legacyV1 && legacyV2,
  'Explicit historical v1/v2 archives required for non-destructive refusal',
);
assert(out && path.resolve(out).startsWith('/tmp/'));
await mkdir(out);
if (mediaDirectory) prepareEditingImages(mediaDirectory, Number(imageSize));
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
const fixture = await build({
  stdin: {
    contents: `
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createAnimation2, createAnimationLayer2 } from '@editor-platform/animation-core/v2';
const content = createAnimation2();
content.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
const first = await commitVersion(createArtifact('animation', 'Saved Animation', content), null, null);
first.draft.content.compositions[0].layers[0].transform.x = 123;
export default await commitVersion(first, null, null);`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { default: record } = await import(
  'data:text/javascript;base64,' + Buffer.from(fixture.outputFiles[0].contents).toString('base64')
);
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://local').pathname;
    assert(!name.includes('..'));
    if (name === '/favicon.ico') return res.writeHead(204).end();
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const errors = [],
  results = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('dialog', (d) => d.accept());
    const click = (name) => page.getByRole('button', { name, exact: true }).click();
    const inspection = () => page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async (record) => {
      const db = await new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open('editor-platform', 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('artifacts', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, record);
    await click('Video');
    await expect(page.locator('#duration')).toBeVisible({ timeout: 30000 });
    await page.locator('#duration').fill('4');
    await click('Resize sequence');
    await click('Refresh Animation versions');
    await expect(page.locator('#animation-source option')).toHaveCount(2);
    await page.selectOption('#animation-source', '0');
    await click('Preview Animation placement');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 30000 });
    await click('Apply Animation preview');
    const before = await inspection();
    assert.equal(before.native.native.content.schema, 'video-core-prototype-v3');
    await page.selectOption('#animation-source', '1');
    await click('Preview Animation update');
    await click('Apply Animation preview');
    assert.notDeepEqual((await inspection()).native.native.content, before.native.native.content);
    await click('Undo');
    assert.deepEqual((await inspection()).native.native.content, before.native.native.content);
    await click('Preview Animation update');
    await click('Apply Animation preview');
    if (mediaDirectory) {
      await exerciseEditingScenario(page, mediaDirectory);
      await exerciseTitleScenario(page);
      await exerciseCaptionScenario(page);
      await exerciseDissolveScenario(page);
    }
    const adopted = (await inspection()).native.native.content;
    await click('Return to Library');
    await expect(page.locator('#notice')).toContainText('Save the project before leaving');
    assert.deepEqual((await inspection()).native.native.content, adopted);
    const save = page.waitForEvent('download');
    await click('Save portable project');
    await (await save).saveAs(path.join(out, `native-${width}.zip`));
    await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
    const savedUrl = page.url();
    // Removing the source catalog after adoption must not remove native owned content.
    await page.evaluate(async (id) => {
      const db = await new Promise((resolve) => {
        const r = globalThis.indexedDB.open('editor-platform', 1);
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').delete(id);
        tx.oncomplete = resolve;
      });
      db.close();
    }, record.id);
    if (mediaDirectory) {
      await page.evaluate(() => {
        globalThis.videoNavigationSentinel = 'same-document';
      });
      await context.setOffline(true);
    }
    await click('Return to Library');
    if (!(await page.locator('[data-private-m2-project]').isVisible()))
      await click('Toggle library');
    await page.locator('[data-private-m2-project]').click();
    await expect(page.locator('#duration')).toBeVisible({ timeout: 30000 });
    assert.equal(page.url(), savedUrl);
    assert.deepEqual((await inspection()).native.native.content, adopted);
    if (mediaDirectory) {
      assert.equal(await page.evaluate(() => globalThis.videoNavigationSentinel), 'same-document');
      await page.evaluate(() => {
        globalThis.videoPreviousHandle = globalThis.editorPrivateVideoHandle;
      });
      await click('Reload saved Video project');
      await page.waitForFunction(
        () =>
          globalThis.editorPrivateVideoHandle &&
          globalThis.editorPrivateVideoHandle !== globalThis.videoPreviousHandle,
      );
      await expect.poll(async () => (await inspection()).native.native.content).toEqual(adopted);
      assert.equal(await page.evaluate(() => globalThis.videoNavigationSentinel), 'same-document');
    }
    await click('Refresh Animation versions');
    await expect(page.locator('#animation-source option')).toHaveCount(0);
    if (mediaDirectory) await context.setOffline(true);
    await page.locator('#preview-frame').fill(mediaDirectory ? '0' : '25');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 30000 });
    assert(
      await page
        .locator('#preview')
        .evaluate((c) =>
          Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).some(
            (n, i) => i % 4 !== 3 && n > 20,
          ),
        ),
      'Retained native Animation must draw visible pixels',
    );
    if (width === 1280) {
      const output = page.waitForEvent('download', { timeout: 120000 });
      await click('Export MP4');
      const file = path.join(out, 'native.mp4');
      await (await output).saveAs(file);
      await expect(page.locator('#status')).toHaveText('Export complete', { timeout: 120000 });
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-count_frames',
            '-show_entries',
            'stream=nb_read_frames,width,height',
            '-of',
            'json',
            file,
          ],
          { encoding: 'utf8' },
        ),
      );
      assert.equal(Number(probe.streams[0].nb_read_frames), mediaDirectory ? 150 : 100);
      if (mediaDirectory) {
        verifyEditingImages(mediaDirectory, file);
        await writeFile(
          path.join(out, 'dissolve-oracle.json'),
          JSON.stringify(verifyDissolveOutput(mediaDirectory, file)),
        );
        await writeFile(
          path.join(out, 'title-oracle.json'),
          JSON.stringify(verifyTitleOutput(file)),
        );
        await writeFile(
          path.join(out, `composite-${width}.json`),
          JSON.stringify(verifyEditingComposite(mediaDirectory, file)),
        );
        // Inspect the contained AV region, independent of the title overlay below it.
        // Title presence/absence is checked separately by verifyTitleOutput.
        const picture = (frame) =>
          execFileSync(
            'ffmpeg',
            [
              '-v',
              'error',
              '-i',
              file,
              '-vf',
              `select=eq(n\\,${frame}),crop=1080:608:0:656`,
              '-frames:v',
              '1',
              '-pix_fmt',
              'rgb24',
              '-f',
              'rawvideo',
              '-',
            ],
            { maxBuffer: 8 * 1024 ** 2 },
          );
        const black = picture(25),
          visible = picture(30);
        assert.equal(black.length, 1080 * 608 * 3);
        assert(
          black.every((v) => v < 8),
          'First media frame fades from the sequence background',
        );
        assert(
          visible.some((v) => v > 100),
          'Later media frame remains visible',
        );
        const audio = JSON.parse(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', file],
            { encoding: 'utf8' },
          ),
        ).streams[0];
        assert.equal(audio.sample_rate, '48000');
        assert.equal(audio.start_pts, 0);
        assert.equal(audio.duration_ts, 288000);
        const pcm = execFileSync(
          'ffmpeg',
          ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
          { maxBuffer: 8 * 1024 ** 2 },
        );
        assert(pcm.length >= 288000 * 4, 'Independent decoder retains the audio presentation');
        assert(
          pcm.some((b) => b !== 0),
          'Output contains audio',
        );
        await writeFile(
          path.join(out, 'audio-oracle.json'),
          JSON.stringify(verifyEditingAudio(adopted, mediaDirectory, file), null, 2),
        );
      }
      const tags = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file],
        { encoding: 'utf8' },
      );
      for (const privateField of [
        'snapshotHash',
        'originals',
        'artifactId',
        'versionId',
        'blackman-windowed-sinc',
      ])
        assert(!tags.includes(privateField), 'Private debug/provenance must not enter MP4 tags');
    }
    if (mediaDirectory) await context.setOffline(false);
    await page.screenshot({ path: path.join(out, `normal-${width}.png`), fullPage: true });
    await click('Return to Library');
    await click('Video');
    await expect(page.locator('#duration')).toBeVisible({ timeout: 30000 });
    assert.equal((await inspection()).native.native.content.schema, 'video-core-prototype-v3');
    const input = page.getByLabel('Open portable Video project', { exact: false });
    await input.setInputFiles(path.join(out, `native-${width}.zip`));
    // Wait for the actual replacement operation, not an arbitrary short content poll.
    await expect(input).toBeEnabled({ timeout: 60000 });
    assert(
      !/^Error:/.test(await page.locator('#notice').textContent()),
      await page.locator('#notice').textContent(),
    );
    await expect(page.locator('#status')).toBeVisible();
    await expect.poll(async () => (await inspection()).native.native.content).toEqual(adopted);
    assert.deepEqual((await inspection()).native.native.content, adopted);
    const beforeRefusal = await inspection();
    const storedBefore = await page.evaluate(() => Object.entries(globalThis.localStorage));
    for (const legacy of [legacyV1, legacyV2]) {
      await input.setInputFiles(legacy);
      await expect(page.locator('#notice')).toContainText('Unsupported legacy Video archive');
      assert.deepEqual((await inspection()).native, beforeRefusal.native);
      assert.deepEqual(
        await page.evaluate(() => Object.entries(globalThis.localStorage)),
        storedBefore,
      );
    }
    // Save the reopened current archive before leaving; rejection did not replace it.
    const finalSave = page.waitForEvent('download');
    await click('Save portable project');
    await finalSave;
    await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
    await click('Return to Library');
    const oldId = '00000000-0000-4000-8000-000000000123';
    const oldKey = 'ep-private-video-m2-locator@0:' + oldId;
    const oldText = JSON.stringify({
      id: oldId,
      namespace: 'normal-video-m2-' + oldId,
      name: 'Retained old Video',
      updatedAt: '2026-10-25T00:00:00Z',
    });
    await page.evaluate(({ key, text }) => globalThis.localStorage.setItem(key, text), {
      key: oldKey,
      text: oldText,
    });
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?privateEditor=video-v2-review&project=${oldId}`,
    );
    await expect(page.getByRole('alert')).toContainText('Unsupported legacy Video project');
    assert.equal(
      await page.evaluate((key) => globalThis.localStorage.getItem(key), oldKey),
      oldText,
    );
    await page.goto(`http://127.0.0.1:${server.address().port}/?privateEditor=video-v1-review`);
    await expect(page.getByRole('alert')).toContainText('Unsupported legacy Video editor');
    results.push({
      width,
      state: 'PASS',
      cases: [
        'Library create/source versions/update/Undo',
        'save/Library reopen after source removal',
        'native preview and actual output',
        'single current v3 creation/portable admission; legacy files/locators refused unchanged',
      ],
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    path.join(out, 'results.json'),
    JSON.stringify(
      { source, imageSize, mediaDirectory: mediaDirectory ?? null, results, errors },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((r) => server.close(r));
}
