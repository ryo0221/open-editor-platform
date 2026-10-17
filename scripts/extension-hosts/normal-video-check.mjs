// Normal production Host acceptance; raw evidence remains outside Git.
import { chromium, expect } from '@playwright/test';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import { reorderedOutputOracleV1 } from '../../packages/video-metadata/host-media/file-source/reordered-oracle-v1.mjs';
const [original, out] = process.argv.slice(2);
assert(original && out && path.resolve(out).startsWith('/tmp/'));
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
let page, context, result;
const errors = [],
  proofs = [];
async function launch(width) {
  context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addInitScript(() => {
    globalThis.File.prototype.arrayBuffer = () => {
      throw Error('Whole File arrayBuffer prohibited');
    };
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'New Video project (private)', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Video — exact timeline', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#open')).toBeHidden();
  assert.equal(
    await page.evaluate(
      () => globalThis.getComputedStyle(globalThis.document.querySelector('#root > div')).overflowY,
    ),
    'auto',
  );
}
const click = (name) => page.getByRole('button', { name, exact: true }).click();
const native = async () => JSON.parse(await page.locator('#native').textContent());
const inspect = () =>
  page.evaluate(async () => {
    const x = await globalThis.editorPrivateVideoHandle.inspection();
    return {
      hash: x.native.hash,
      content: x.native.native.content,
      originals: x.native.originals.map((o) => ({
        sourceId: o.sourceId,
        bytes: o.bytes.size,
        plan: o.plan,
      })),
      versions: x.versions,
    };
  });
async function save(name) {
  const pending = page.waitForEvent('download', { timeout: 300000 });
  pending.catch(() => {});
  await click('Save portable project');
  await (await pending).saveAs(path.join(out, name));
  await expect(page.locator('#status')).toHaveText('Save complete');
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.', {
    timeout: 30000,
  });
  return inspect();
}
async function finish(width) {
  await page.evaluate(() => globalThis.editorPrivateVideoHandle.close());
  await context.tracing.stop({ path: path.join(out, `trace-${width}.zip`) });
  await context.close();
  context = undefined;
}
try {
  await launch(1280);
  await page.locator('#import').setInputFiles(original);
  await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  const initial = { native: await native() };
  const first = await save('first.zip');
  assert.equal(first.versions.versions.length, 1);
  await page.locator('#at').fill('2001/1000');
  await click('Split linked clips');
  const split = await native();
  const firstPair = split.sequence.clips.filter((c) => c.start.value === 0);
  const lastPair = split.sequence.clips.filter((c) => c.start.value !== 0);
  await page.locator('#trim-start').fill('1/1000');
  await page.locator('#trim-end').fill('2001/1000');
  for (const clip of firstPair) {
    await page.locator('#selected').selectOption(clip.id);
    await click('Trim selected clip');
  }
  await page.locator('#trim-start').fill('41051/600');
  await page.locator('#trim-end').fill('42251/600');
  for (const clip of lastPair) {
    await page.locator('#selected').selectOption(clip.id);
    await click('Trim selected clip');
  }
  // Park the early pair beyond the old end, move the true-end pair to zero, then early pair to two.
  await page.locator('#selected').selectOption(firstPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('42251/600');
  await click('Move linked clips');
  await page.locator('#selected').selectOption(lastPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('-41051/600');
  await click('Move linked clips');
  await page.locator('#selected').selectOption(firstPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('-102629/1500');
  await click('Move linked clips');
  await page.locator('#duration').fill('4');
  await click('Resize sequence');
  const edited = { native: await native() };
  assert.equal(edited.native.sequence.clips.length, 4);
  assert.deepEqual(edited.native.sources, initial.native.sources);
  assert.deepEqual(edited.native.sequence.duration, { value: 4, timescale: 1 });
  const expectedMapping = [
    {
      start: { value: 0, timescale: 1 },
      duration: { value: 2, timescale: 1 },
      sourceIn: { value: 41051, timescale: 600 },
      sourceOut: { value: 42251, timescale: 600 },
    },
    {
      start: { value: 2, timescale: 1 },
      duration: { value: 2, timescale: 1 },
      sourceIn: { value: 1, timescale: 1000 },
      sourceOut: { value: 2001, timescale: 1000 },
    },
  ];
  for (const kind of ['video', 'audio']) {
    const mapping = edited.native.sequence.clips
      .filter((c) => c.kind === kind)
      .sort((a, b) => a.start.value / a.start.timescale - b.start.value / b.start.timescale)
      .map((c) => ({
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
      }));
    assert.deepEqual(mapping, expectedMapping);
  }
  const second = await save('reordered.zip');
  await click('Undo');
  await click('Redo');
  assert.deepEqual(await native(), edited.native);
  const third = await save('portable-v1.zip');
  assert.equal(third.versions.versions.length, 3);
  assert.deepEqual(third.versions.versions.slice(0, 2), second.versions.versions);
  const url = page.url();
  await click('Saved Video versions');
  await expect(page.locator('#versions details')).toHaveCount(3);
  await click('Reload saved Video project');
  await expect(
    page.getByRole('heading', { name: 'Video — exact timeline', exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await expect.poll(native, { timeout: 120000 }).toEqual(edited.native);
  assert.equal(page.url(), url);
  assert.deepEqual((await inspect()).versions, third.versions);
  const fourth = await save('reload-saved.zip');
  assert.equal(fourth.versions.versions.length, 4);
  assert.deepEqual(fourth.versions.versions.slice(0, 3), third.versions.versions);
  await click('Return to Library');
  await expect(
    page.getByRole('button', { name: 'New Video project (private)', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: /Video project [a-f0-9]{8}/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Video — exact timeline', exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await expect.poll(native, { timeout: 120000 }).toEqual(edited.native);
  const beforeBad = await inspect();
  await page.getByLabel('Open portable Video project').setInputFiles({
    name: 'bad.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('invalid archive'),
  });
  await expect(page.locator('#notice')).not.toHaveText('');
  assert.deepEqual(await inspect(), beforeBad);
  await expect(
    page.getByRole('button', { name: 'Save portable project', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: path.join(out, 'library-reopened-1280.png'), fullPage: true });
  proofs.push({
    stage: 'normal-library-reload',
    first,
    second,
    third,
    fourth,
    edited,
    rejectedPortablePreservedOwner: true,
  });
  await finish('library-1280');
  for (const width of [1280, 390]) {
    await launch(width);
    await page
      .getByLabel('Open portable Video project')
      .setInputFiles(path.join(out, 'portable-v1.zip'));
    await expect.poll(native, { timeout: 300000 }).toEqual(edited.native);
    const reopened = await inspect();
    assert.equal(reopened.hash, third.hash);
    assert.deepEqual(reopened.originals, third.originals);
    assert.deepEqual(reopened.versions, third.versions);
    const saved = await save(`fresh-${width}.zip`);
    assert.equal(saved.versions.versions.length, 4);
    assert.deepEqual(saved.versions.versions.slice(0, 3), third.versions.versions);
    await page.locator('#preview-frame').focus();
    await expect(page.locator('#preview-frame')).toBeFocused();
    assert(
      await page.evaluate(() => {
        const root = globalThis.document.querySelector('#root > div');
        return root.scrollWidth <= root.clientWidth + 1;
      }),
    );
    await page.locator('#preview-frame').fill('49');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 120000 });
    await page.screenshot({ path: path.join(out, `preview-${width}.png`), fullPage: true });
    await page.locator('#preview-frame').fill('0');
    await click('Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 120000 });
    assert.equal(JSON.parse(await page.locator('#playback').textContent()).state, 'ended');
    if (width === 1280) {
      const pending = page.waitForEvent('download', { timeout: 660000 });
      pending.catch(() => {});
      await click('Export MP4');
      await (await pending).saveAs(path.join(out, 'edited.mp4'));
      await expect(page.locator('#status')).toHaveText('Export complete');
    }
    proofs.push({ stage: 'normal-fresh-origin', width, reopened, saved });
    await finish(`fresh-${width}`);
  }
  const oracle = await reorderedOutputOracleV1(original, path.join(out, 'edited.mp4'), out);
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    code,
    proofs,
    oracle,
    errors,
    limitations: [
      'Physical Safari NOT RUN',
      'Mobile export NOT RUN',
      'Performance held',
      'Cross-tab catalog concurrency NOT RUN',
    ],
  };
} catch (error) {
  result = { state: 'FAIL', code, error: String(error), stack: error.stack, proofs, errors };
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (context)
    await context.tracing.stop({ path: path.join(out, 'failure-trace.zip') }).catch(() => {});
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
}
