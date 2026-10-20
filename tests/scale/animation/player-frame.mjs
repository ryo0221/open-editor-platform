/**
 * Animation Player frame benchmark: mounts mountAnimationPlayer2 in Chromium with a
 * manual clock and times 195 warm seeks (evaluate + DOM update + forced layout).
 *   node tests/scale/animation/player-frame.mjs   (CHROMIUM_PATH overrides the browser)
 */
/* global window, console */
import process from 'node:process';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const png = [...readFileSync('tests/fixtures/office/images/quadrants.png')];
const out = await build({
  entryPoints: ['tests/scale/animation/player-entry.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  define: { PNG: JSON.stringify(png) },
  conditions: ['import'],
  logLevel: 'error',
});
// Same browser selection as playwright.config.ts; CHROMIUM_PATH overrides it.
const executablePath =
  process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: out.outputFiles[0].text });
for (const [layers, images, animated] of [
  [100, 0, 100],
  [1000, 0, 200],
  [100, 2, 100],
  [998, 2, 200],
]) {
  const r = await page.evaluate(([a, b, c]) => window.bench(a, b, c), [layers, images, animated]);
  console.log(
    `FRAME layers=${layers} images=${images} animated=${animated}: median ${r.median.toFixed(2)}ms p95 ${r.p95.toFixed(2)}ms nodes=${r.nodes}`,
  );
}
await browser.close();
// A render that logged browser errors is not a valid timing result.
if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
