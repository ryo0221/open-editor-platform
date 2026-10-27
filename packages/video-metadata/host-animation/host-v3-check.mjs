import { productBuild } from '../host-media/product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import assert from 'node:assert/strict';
const [out, deps, media] = process.argv.slice(2);
assert(out && deps && media);
await mkdir(out);
const license = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
assert.equal(license, await readFile('node_modules/@noble/hashes/LICENSE', 'utf8'));
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-animation/host-v3-harness.mjs',
  banner: { js: '/*!\n' + license + '\n*/' },
});

const server = createServer((req, res) => {
  if (req.url === '/test.js') {
    res.setHeader('content-type', 'application/javascript');
    res.end(built.outputFiles[0].contents);
  } else if (req.url === '/favicon.ico') res.writeHead(204).end();
  else
    res.end(
      '<!doctype html><style>body{font:16px sans-serif}label{display:block;margin:8px}button{margin:4px;padding:8px}main{max-width:1100px;margin:auto}input,select,canvas{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main></main><script type="module" src="/test.js"></script>',
    );
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
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => globalThis.animationReady);
    const click = async (name) => {
      await page.getByRole('button', { name, exact: true }).click();
    };
    const content = () => page.evaluate(() => globalThis.animationFixture.read());
    await click('Refresh Animation versions');
    await expect(page.locator('#status')).toHaveText('Animation sources complete');
    await click('Preview Animation placement');
    await expect(page.locator('#status')).toHaveText('Animation preview complete');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 30000 });
    await click('Apply Animation preview');
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v1');
    assert.equal(await page.evaluate(() => globalThis.animationFixture.leases()), 0);
    await page.evaluate(() => globalThis.animationFixture.save());
    await page.selectOption('#animation-source', '1');
    await click('Preview Animation update');
    await expect(page.locator('#status')).toHaveText('Animation preview complete');
    await click('Apply Animation preview');
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v2');
    await click('Undo');
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v1');
    await click('Redo');
    await page.evaluate(() => globalThis.animationFixture.save());
    await page.evaluate(() => globalThis.animationFixture.capture());
    assert.deepEqual(await page.evaluate(() => globalThis.animationFixture.archiveVersions()), [
      'v1',
      'v2',
    ]);
    assert.equal(await page.evaluate(() => globalThis.animationFixture.oldReaderRefuses()), true);
    await page.selectOption('#animation-source', '0');
    await click('Preview Animation update');
    await expect(page.locator('#status')).toHaveText('Animation preview complete');
    await page.locator('#duration').fill('5');
    await click('Resize sequence');
    await click('Apply Animation preview');
    await expect(page.locator('#status')).toContainText('Stale Animation preview');
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v2');
    assert.equal(await page.evaluate(() => globalThis.animationFixture.leases()), 0);
    await click('Undo');
    await click('Preview Animation update');
    await expect(page.locator('#status')).toHaveText('Animation preview complete');
    await page.evaluate(() => globalThis.animationFixture.setRead(false));
    await click('Apply Animation preview');
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v2');
    assert.equal(await page.evaluate(() => globalThis.animationFixture.leases()), 0);
    await page.evaluate(() => globalThis.animationFixture.setRead(true));
    await page.selectOption('#animation-source', '0');
    await click('Preview Animation update');
    await expect(page.locator('#status')).toHaveText('Animation preview complete');
    await page.evaluate(() => globalThis.animationFixture.setEdit(false));
    await click('Apply Animation preview');
    await assert.rejects(content(), /ScopeRevoked/);
    assert.equal(await page.evaluate(() => globalThis.animationFixture.leases()), 0);
    await page.evaluate(() => globalThis.animationFixture.setEdit(true));
    await page.evaluate(() => globalThis.animationFixture.reopen());
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v2');
    await page.evaluate(() => globalThis.animationFixture.clearSources());
    await page.evaluate(() => globalThis.animationFixture.reopen());
    assert.equal((await content()).sequence.clips[0].embed.source.versionId, 'v2');
    await page.locator('#preview-frame').fill('25');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 30000 });
    const drawn = await page
      .locator('#preview')
      .evaluate(
        (c) =>
          Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).filter(
            (n, i) => i % 4 !== 3 && n > 20,
          ).length,
      );
    assert(drawn > 100, 'Native Animation must draw visible pixels');
    if (width === 1280) {
      const download = page.waitForEvent('download', { timeout: 120000 });
      await click('Export MP4');
      const file = out + '/animation.mp4';
      await (await download).saveAs(file);
      await expect(page.locator('#status')).toHaveText('Export complete', { timeout: 120000 });
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v',
            '-count_frames',
            '-show_entries',
            'stream=codec_name,width,height,nb_read_frames',
            '-of',
            'json',
            file,
          ],
          { encoding: 'utf8' },
        ),
      );
      assert.equal(probe.streams[0].codec_name, 'h264');
      assert.equal(Number(probe.streams[0].nb_read_frames), 100);
      assert.equal(probe.streams[0].width, 1080);
      assert.equal(probe.streams[0].height, 1920);
      const tags = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file],
        { encoding: 'utf8' },
      );
      assert(
        !tags.includes('native-animation') &&
          !tags.includes('versionId') &&
          !tags.includes('artifactId'),
        'Private Animation identities must not enter output metadata',
      );
      const decoded = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          'select=eq(n\\,25),scale=270:480',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-',
        ],
        { maxBuffer: 1024 * 1024 },
      );
      assert(
        decoded.filter((n, i) => i % 4 !== 3 && n > 20).length > 100,
        'Independent decoded Animation frame is visible',
      );
      await writeFile(out + '/export-video.json', JSON.stringify(probe, null, 2));
      await click('Export MP4');
      await page.waitForFunction(
        () =>
          globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')].snapshot()
            .pixels > 0,
        { timeout: 20000 },
      );
      await click('Stop media');
      await expect(page.locator('#status')).toContainText(/Abort|abort|cancel/i, {
        timeout: 30000,
      });
      assert.equal(
        await page.evaluate(
          () =>
            globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')].snapshot()
              .pixels,
        ),
        0,
      );
      await page.locator('#preview-frame').fill('0');
      await click('Play');
      await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 30000 });
      assert.equal(
        await page.evaluate(
          () =>
            globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')].snapshot()
              .pixels,
        ),
        0,
      );
    }
    await page.locator('#import').setInputFiles(media);
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 30000 });
    assert.equal((await content()).sequence.clips.filter((c) => c.kind === 'animation').length, 1);
    assert.equal((await content()).sources.length, 1);
    await page.evaluate(() => globalThis.animationFixture.save());
    await page.evaluate(() => globalThis.animationFixture.capture());
    await page.evaluate(() => globalThis.animationFixture.reopen());
    await page.locator('#preview-frame').fill('125');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 30000 });
    assert.equal(
      await page.evaluate(
        () =>
          globalThis[Symbol.for('editor-platform.private.decoded-frame-budget.v1')].snapshot()
            .pixels,
      ),
      0,
    );
    const archivePath = out + '/reopen-' + width + '.zip';
    await writeFile(
      archivePath,
      Uint8Array.from(await page.evaluate(() => globalThis.animationFixture.archiveBytes())),
    );
    await page.locator('#open').setInputFiles(archivePath);
    await expect(page.locator('main > section #animation-source')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#animation-source')).toHaveCount(1);
    await click('Refresh Animation versions');
    await expect(page.locator('#status')).toHaveText('Animation sources complete');
    await page.screenshot({ path: out + '/host-' + width + '.png', fullPage: true });
    await page.evaluate(() => globalThis.animationFixture.close());
    await page.close();
    results.push({
      width,
      state: 'PASS',
      cases: [
        'placement/update/undo and stale preview refusal',
        'source revocation refusal',
        'edit permission revocation refuses and requires fresh Host',
        'retained versions/save/reopen without live source',
        'old reader refusal',
        'mixed native/media save/reopen and preview',
      ],
    });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    out + '/results.json',
    JSON.stringify(
      {
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
        results,
        errors,
      },
      null,
      2,
    ),
  );
}
