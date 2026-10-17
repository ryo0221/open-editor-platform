/* global document, structuredClone, HTMLMediaElement */
// Focused real-browser checks for the Host-owned temporary known-asset decoder.
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const mediaRoot = path.resolve(process.argv[2]);
const out = await mkdtemp('/tmp/issue76-media-adapter-');
const reports = [];
for (const kind of ['reference', 'independent']) {
  await build({
    stdin: {
      contents: `
    import {TemporaryMediaPool} from ${JSON.stringify(path.resolve(`examples/${kind}-extension-host/media-preview.ts`))};
    const signal = new AbortController();
    globalThis.scopeAllowed = true;
    const pool = new TemporaryMediaPool(signal.signal, () => {
      const current = !signal.signal.aborted && globalThis.scopeAllowed;
      globalThis.onScopeCheck?.();
      return current;
    });
    const sources=[];
    Object.assign(globalThis,{pool,signal,sources,
      accept:async()=>{const source=await pool.accept(document.querySelector('input').files[0]);sources.push(source);return source;},
      seek:(i,t)=>pool.seek(sources[i],{value:t,timescale:25},document.querySelector('canvas'))
    });
  `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    outfile: path.join(out, `${kind}.js`),
  });
}
const server = createServer(async (req, res) => {
  if (req.url?.endsWith('.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(path.join(out, req.url.slice(1))));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><input type="file"><canvas></canvas><script type="module" src="/${req.url === '/independent' ? 'independent' : 'reference'}.js"></script>`,
    );
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
try {
  for (const kind of ['reference', 'independent']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => {
      errors.push(String(e));
      console.error('BROWSER', String(e));
    });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('CONSOLE', m.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${kind}`);
    await page.waitForFunction('globalThis.pool', null, { timeout: 10000 });
    for (const domain of ['animation', 'geo']) {
      await page
        .locator('input')
        .setInputFiles(path.join(mediaRoot, `editor-platform-${domain}-reference-b18369f2.mp4`));
      await page.evaluate('accept()');
    }
    for (const index of [0, 1])
      for (const frame of [
        0,
        1,
        25,
        ...Array.from({ length: 100 }, (_, i) => 125 + i),
        300,
        index === 0 ? 695 : 694,
      ]) {
        const r = await page.evaluate(([i, n]) => globalThis.seek(i, n), [index, frame]);
        assert.equal(r.decodedSeconds, frame / 25);
        assert.equal(r.requestedSeconds, frame / 25);
      }
    // Exact rational requests immediately around verified frame boundaries.
    // These are actual decoder assertions, separate from any floating-point PTS tolerance.
    for (const source of [0, 1]) {
      for (const [value, timescale, expected] of [
        [1999999999, 50000000000, 0],
        [1, 25, 0.04],
        [2000000001, 50000000000, 0.04],
        [499999999999, 50000000000, 9.96],
        [10, 1, 10],
        [500000000001, 50000000000, 10],
      ]) {
        const r = await page.evaluate(
          ([source, value, timescale]) =>
            globalThis.pool.seek(
              globalThis.sources[source],
              { value, timescale },
              document.querySelector('canvas'),
            ),
          [source, value, timescale],
        );
        assert.equal(r.decodedSeconds, expected, `${kind} source ${source}: ${value}/${timescale}`);
      }
    }
    const race = await page.evaluate(async () => {
      const old = globalThis.seek(0, 100).then(
        () => 'unexpected',
        (e) => String(e),
      );
      const fresh = globalThis.seek(1, 250);
      return [await old, await fresh];
    });
    assert.match(race[0], /MediaSeekSuperseded/);
    assert.equal(race[1].decodedSeconds, 10);
    // Repeated actual decoder supersession must never adopt a queued old seek frame.
    for (let turn = 0; turn < 20; turn++) {
      const pair = await page.evaluate(async (turn) => {
        const old = globalThis.seek(0, 130 + turn).then(
          () => 'unexpected',
          (e) => String(e),
        );
        const fresh = globalThis.seek(0, 300 + turn);
        return [await old, await fresh];
      }, turn);
      assert.match(pair[0], /MediaSeekSuperseded/);
      assert.equal(pair[1].decodedSeconds, (300 + turn) / 25);
    }
    const mismatch = await page.evaluate(async () => {
      const altered = structuredClone(globalThis.sources[0]);
      altered.streams[0].endPts++;
      return globalThis.pool
        .seek(altered, { value: 1, timescale: 1 }, document.querySelector('canvas'))
        .then(
          () => 'unexpected',
          (e) => String(e),
        );
    });
    assert.match(mismatch, /MediaMetadataMismatch/);
    const revoked = await page.evaluate(async () => {
      const pending = globalThis.seek(0, 200).then(
        () => 'unexpected',
        (e) => String(e),
      );
      globalThis.signal.abort();
      return {
        outcome: await pending,
        state: globalThis.pool.inspect(),
        blank: !document
          .querySelector('canvas')
          .getContext('2d')
          .getImageData(0, 0, 1, 1)
          .data.some(Boolean),
      };
    });
    assert.match(revoked.outcome, /MediaSeekSuperseded|MediaScopeClosed/);
    assert.deepEqual(revoked.state, { stopped: true, assets: [], urlsCreated: 2, urlsReleased: 2 });
    assert.equal(revoked.blank, true);
    await expect.poll(() => page.evaluate('pool.inspect().urlsReleased')).toBe(2);
    // Unknown bytes never acquire a URL or get represented as a native media source.
    await page.reload();
    await page.waitForFunction('globalThis.pool');
    await page.locator('input').setInputFiles({
      name: 'unknown.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('not the verified recording'),
    });
    assert.match(
      await page.evaluate('accept().then(()=>"unexpected", e=>String(e))'),
      /MediaUnverifiedAsset/,
    );
    assert.equal((await page.evaluate('pool.inspect()')).urlsCreated, 0);
    // Actual loadedmetadata fires, but a conflicting browser duration must refuse and release.
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration').get;
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get() {
          return original.call(this) + 1;
        },
      });
    });
    await page
      .locator('input')
      .setInputFiles(path.join(mediaRoot, 'editor-platform-animation-reference-b18369f2.mp4'));
    assert.match(
      await page.evaluate('accept().then(()=>"unexpected", e=>String(e))'),
      /MediaMetadataMismatch/,
    );
    assert.deepEqual(await page.evaluate('pool.inspect()'), {
      stopped: false,
      assets: [],
      urlsCreated: 1,
      urlsReleased: 1,
    });
    await page.reload();
    await page.waitForFunction('globalThis.pool');
    // Losing Host scope is terminal even if a caller later flips its local flag back.
    await page
      .locator('input')
      .setInputFiles(path.join(mediaRoot, 'editor-platform-animation-reference-b18369f2.mp4'));
    await page.evaluate('accept()');
    await page.evaluate('seek(0,25)');
    await page.evaluate('scopeAllowed=false');
    assert.match(
      await page.evaluate('seek(0,50).then(()=>"unexpected",e=>String(e))'),
      /MediaScopeClosed/,
    );
    await page.evaluate('scopeAllowed=true');
    assert.match(
      await page.evaluate('seek(0,25).then(()=>"unexpected",e=>String(e))'),
      /MediaScopeClosed/,
    );
    assert.deepEqual(await page.evaluate('pool.inspect()'), {
      stopped: true,
      assets: [],
      urlsCreated: 1,
      urlsReleased: 1,
    });
    await page.reload();
    await page.waitForFunction('globalThis.pool');
    // Close the scope during hash preparation: no URL is created after the late hash.
    await page.evaluate(() => {
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      globalThis.crypto.subtle.digest = (...args) =>
        new Promise((resolve, reject) => {
          globalThis.releaseHash = () => digest(...args).then(resolve, reject);
        });
    });
    await page
      .locator('input')
      .setInputFiles(path.join(mediaRoot, 'editor-platform-animation-reference-b18369f2.mp4'));
    await page.evaluate(() => {
      globalThis.accepting = globalThis.accept().then(
        () => 'unexpected',
        (e) => String(e),
      );
    });
    await page.waitForFunction('globalThis.releaseHash');
    await page.evaluate(() => {
      globalThis.signal.abort();
      globalThis.releaseHash();
    });
    assert.match(await page.evaluate('accepting'), /MediaScopeClosed/);
    assert.deepEqual(await page.evaluate('pool.inspect()'), {
      stopped: true,
      assets: [],
      urlsCreated: 0,
      urlsReleased: 0,
    });
    // A Host callback may synchronously close the pool while returning its earlier true.
    // Trigger only the check AFTER the real hash has completed, immediately before URL creation.
    for (const mode of ['abort', 'dispose']) {
      await page.reload();
      await page.waitForFunction('globalThis.pool');
      await page.evaluate((mode) => {
        const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
        globalThis.crypto.subtle.digest = async (...args) => {
          const hash = await digest(...args);
          globalThis.hashFinished = true;
          return hash;
        };
        globalThis.onScopeCheck = () => {
          if (!globalThis.hashFinished) return;
          globalThis.closedDuringCheck = true;
          if (mode === 'abort') globalThis.signal.abort();
          else globalThis.pool.dispose();
        };
      }, mode);
      await page
        .locator('input')
        .setInputFiles(path.join(mediaRoot, 'editor-platform-animation-reference-b18369f2.mp4'));
      assert.match(
        await page.evaluate('accept().then(()=>"unexpected", e=>String(e))'),
        /MediaScopeClosed/,
      );
      assert.equal(await page.evaluate('closedDuringCheck'), true);
      assert.deepEqual(
        await page.evaluate('pool.inspect()'),
        {
          stopped: true,
          assets: [],
          urlsCreated: 0,
          urlsReleased: 0,
        },
        `${kind}: ${mode} during post-hash scope check must never create a URL`,
      );
    }
    assert.deepEqual(errors, []);
    reports.push({
      kind,
      result: 'PASS',
      cases:
        '2 real files; exact CFR frame seek; superseded seek; native metadata mismatch; abort during seek/hash; unknown bytes; browser/native metadata mismatch; cleared pixels; URL release',
    });
    await page.close();
    console.log('PASS', kind, 'temporary real-media adapter');
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(reports, null, 2));
console.log('Evidence', out);
