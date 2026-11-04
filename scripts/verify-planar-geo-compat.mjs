/** Explicit functional check, no benchmark, server, public export or worktree. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.equal(
  args.length,
  4,
  'usage: node scripts/verify-planar-geo-compat.mjs --baseline COMMIT --output NEW_DIRECTORY',
);
assert.equal(args[0], '--baseline');
assert.equal(args[2], '--output');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' });
const baseline = git('rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`).trim();
assert.match(baseline, /^[a-f0-9]{40,64}$/);
const output = path.resolve(args[3]);
const relativeOutput = path.relative(root, output);
assert.ok(
  relativeOutput.startsWith('..' + path.sep) || path.isAbsolute(relativeOutput),
  'generated output must stay outside the repository',
);
assert.ok(
  !existsSync(output) || readdirSync(output).length === 0,
  'use a new/empty output directory; retain previous evidence',
);
mkdirSync(output, { recursive: true });
const atBaseline = (name) => git('show', `${baseline}:${name}`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Third-party versions and public resolution must match. A test-only devDependency
// may change; neither runtime dependencies nor source are silently substituted.
assert.equal(atBaseline('package.json'), readFileSync(path.join(root, 'package.json'), 'utf8'));
const oldLock = JSON.parse(atBaseline('package-lock.json')).packages;
const newLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
const thirdParty = (lock) =>
  Object.fromEntries(
    Object.entries(lock).filter(
      ([name]) =>
        name.startsWith('node_modules/') && !name.startsWith('node_modules/@editor-platform/'),
    ),
  );
assert.deepEqual(thirdParty(oldLock), thirdParty(newLock));
for (const pkg of ['geo-core', 'geo-inspector', 'artifact-core']) {
  const name = `packages/${pkg}/package.json`;
  const before = JSON.parse(atBaseline(name));
  const after = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
  assert.deepEqual(after.exports, before.exports);
  assert.deepEqual(after.dependencies, before.dependencies);
}
const baselineModules = {};
const oldSources = {
  name: 'pinned-git-package-sources',
  setup(builder) {
    builder.onLoad({ filter: /\.(?:ts|tsx|mjs|json|css)$/ }, async ({ path: filename }) => {
      const name = path.relative(root, filename).split(path.sep).join('/');
      if (!name.startsWith('packages/')) return;
      const contents = atBaseline(name); // Missing baseline modules fail; no fallback.
      baselineModules[name] = sha(contents);
      return {
        contents,
        loader: path.extname(filename) === '.mjs' ? 'js' : path.extname(filename).slice(1),
        resolveDir: path.dirname(filename),
      };
    });
  },
};
const metadata = [];
async function bundle(entry, globalName, plugins = []) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    plugins,
  });
  assert.equal(result.outputFiles.length, 1);
  assert.ok(Object.values(result.metafile.outputs).every((item) => item.imports.length === 0));
  metadata.push(result.metafile);
  return result.outputFiles[0].text;
}
const fixture = 'tests/fixtures/planar-r1/geo-output.ts';
const oldBundle = await bundle(fixture, 'GeoBaseline', [oldSources]);
for (const name of Object.keys(metadata[0].inputs))
  assert.ok(
    name === fixture || name.startsWith('node_modules/') || Object.hasOwn(baselineModules, name),
    `unpinned baseline module: ${name}`,
  );
for (const pkg of new Set(Object.keys(baselineModules).map((name) => name.split('/')[1]))) {
  const name = `packages/${pkg}/package.json`;
  const before = JSON.parse(atBaseline(name));
  const after = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
  assert.deepEqual(after.exports, before.exports, `${pkg}: baseline export resolution changed`);
  assert.deepEqual(after.dependencies, before.dependencies, `${pkg}: runtime dependencies changed`);
}
const newBundle = await bundle(fixture, 'GeoCandidate');
const planarBundle = await bundle('tests/fixtures/planar-r1/planar-smoke.ts', 'PlanarCandidate');
const currentModules = {};
for (const meta of metadata.slice(1))
  for (const name of Object.keys(meta.inputs))
    currentModules[name] = sha(readFileSync(path.resolve(root, name)));
const results = [];
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const [label, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === 'http://127.0.0.1:4389' && url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><head><title>Geo compatibility</title></head><body></body></html>',
          });
        if (url.origin === 'http://127.0.0.1:4389' && url.pathname === '/favicon.ico')
          return route.fulfill({ status: 204 });
        errors.push('unexpected external resource: ' + url.origin + url.pathname);
        return route.abort();
      });
      await page.goto('http://127.0.0.1:4389/');
      await page.evaluate(() => globalThis.document.fonts.ready);
      await page.addScriptTag({ content: oldBundle });
      const before = await page.evaluate(() =>
        globalThis.GeoBaseline.captureGeoOutput(globalThis.document),
      );
      await page.addScriptTag({ content: newBundle });
      const after = await page.evaluate(() =>
        globalThis.GeoCandidate.captureGeoOutput(globalThis.document),
      );
      for (const [name, value] of [
        ['baseline', before],
        ['candidate', after],
      ]) {
        assert.equal(value.native, value.roundtrip);
        assert.equal(value.native, value.after);
        assert.ok(value.svg.includes('Dateline'));
        assert.ok(value.png.length > 1000);
        assert.deepEqual(value.png.slice(0, 4), [137, 80, 78, 71]);
        assert.equal(value.receipt.outputBytesHash, 'sha256:' + sha(Buffer.from(value.png)));
        writeFileSync(path.join(output, `${label}-${name}.png`), Buffer.from(value.png));
        writeFileSync(path.join(output, `${label}-${name}.svg`), value.svg);
        writeFileSync(path.join(output, `${label}-${name}.native.json`), value.native);
        writeFileSync(
          path.join(output, `${label}-${name}.receipt.json`),
          JSON.stringify(value.receipt, null, 2) + '\n',
        );
      }
      assert.deepEqual(after, before, `${label}: native/hash/SVG/PNG/receipt changed`);
      await page.addScriptTag({ content: planarBundle });
      const planar = await page.evaluate(() => globalThis.PlanarCandidate.capturePlanarResults());
      assert.deepEqual(planar, {
        point: { ok: true, value: [0, -0] },
        invalid: { ok: false, diagnostic: { kind: 'input', code: 'coordinate-not-finite' } },
        position: { ok: true, value: 'interior' },
        cross: { ok: true, value: 'cross' },
        tiny: { ok: true, value: { vertexCount: 3, winding: 'positive' } },
        huge: { ok: true, value: { vertexCount: 3, winding: 'positive' } },
        bowtie: {
          ok: false,
          diagnostic: { kind: 'geometry', code: 'self-crossing', edgeIndices: [0, 2] },
        },
        budget: { ok: false, diagnostic: { kind: 'budget', code: 'vertex-limit' } },
      });
      assert.deepEqual(errors, []);
      results.push({
        label,
        viewport,
        engine: browser.version(),
        nativeHash: after.hash,
        pngHash: after.receipt.outputBytesHash,
        svgHash: sha(after.svg),
        checks: 8,
      });
      log(
        `${label}: PASS Geo native/hash/SVG/PNG/receipt equality; planar browser checks 8/8; no browser errors/external resources`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const report = {
  checkerSourceHash: sha(readFileSync(fileURLToPath(import.meta.url))),
  baseline,
  candidateParent: git('rev-parse', 'HEAD').trim(),
  dirtyPaths: git('diff', '--name-only').trim().split('\n'),
  sourceHash: sha(JSON.stringify(Object.entries(currentModules).sort())),
  currentModules,
  baselineModules,
  results,
};
writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
log(`Evidence: ${output}; candidate source SHA-256 ${report.sourceHash}`);
