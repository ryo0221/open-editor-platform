import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import type { BrowserContext } from '@playwright/test';
import { test, expect, nativeArtifact } from './fixtures';
import type { startFixture } from './fixtures/hosted-projects';

test('two authorized viewers edit a native Video, play the original, and open a Character with its original mesh', async ({
  page,
  browser,
  baseURL,
}) => {
  // Cold-load two distinct 3D and Video surfaces in two isolated browser contexts.
  test.setTimeout(120_000);
  // One second of FFmpeg's testsrc2 encoded as 48x32 VP8. Decode the same original on both clients.
  const encoded = await readFile('tests/e2e/fixtures/hosted-video.webm');
  const bundle = await build({
    entryPoints: ['tests/e2e/fixtures/hosted-projects.ts'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    write: false,
  });
  const { startFixture: start } = (await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
  )) as { startFixture: typeof startFixture };
  const fixture = await start(encoded);
  const guest = await browser.newContext({ baseURL });
  const errors: string[] = [];
  const meshRequests: { who: string; revision: string | null; method: string }[] = [];
  const wire = async (context: BrowserContext, who: string) => {
    await context.addCookies([{ name: 'fixture', value: who, url: baseURL!, httpOnly: true }]);
    await context.route('**/collaboration-api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/editor/media') && url.searchParams.get('assetId') === 'mesh-body')
        meshRequests.push({ who, revision: url.searchParams.get('revision'), method: route.request().method() });
      const response = await route.fetch({ url: fixture.base + url.pathname + url.search });
      await route.fulfill({ response });
      await response.dispose();
    });
  };
  try {
    await wire(page.context(), 'author');
    await wire(guest, 'recipient');
    const b = await guest.newPage();
    b.on('pageerror', (e) => errors.push(e.message));
    for (const participant of [page, b]) {
      await participant.goto('/?videoCollaboration=host-video-film');
      await expect(participant.getByRole('status')).toContainText('confirmed r0');
      const movie = participant.locator('video');
      await expect.poll(() => movie.evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBe(48);
    }
    await page.getByLabel('開始位置（秒）').fill('2');
    await page.getByRole('button', { name: '適用する' }).click();
    await expect(b.getByTestId('clip-range')).toHaveText('2–4 秒');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(b.getByText('保存した版 r1')).toBeVisible();
    fixture.setReleaseActive(false);
    await expect(b.locator('video')).toHaveCount(0);
    await expect(page.locator('video')).toBeVisible();
    await expect(b.getByTestId('clip-range')).toHaveText('2–4 秒');
    fixture.setReleaseActive(true);
    await expect(b.locator('video')).toBeVisible();
    for (const participant of [page, b]) {
      const bytes = participant.waitForResponse(
        (r) =>
          r.url().includes('/editor/media?') &&
          r.url().includes('mesh-body') &&
          r.request().method() === 'GET' &&
          r.status() === 200,
      );
      await participant.goto('/?shared=host-character-figure&kind=character');
      await expect(participant.getByLabel('Character view')).toBeVisible();
      expect((await (await bytes).body()).length).toBeGreaterThan(100);
      await expect(participant.getByText(/表示できない素材があります/)).toHaveCount(0);
    }
    for (const participant of [page, b]) {
      const parts = participant.getByRole('complementary', { name: 'Parts', exact: true });
      if (!(await parts.isVisible())) await participant.getByRole('button', { name: 'Toggle Parts', exact: true }).click();
    }
    const body = (participant: typeof page) => participant.getByRole('checkbox', { name: 'Show Body', exact: true });
    const originals = meshRequests.filter(r => r.method === 'GET').length;
    await body(page).uncheck();
    await expect(body(b)).not.toBeChecked();
    await page.getByRole('banner').getByRole('button', {name: 'Undo', exact: true}).click();
    await expect(body(b)).toBeChecked();
    for (const who of ['author', 'recipient']) {
      await expect.poll(() => meshRequests.some(r => r.who === who && r.method === 'HEAD' && r.revision === '2')).toBe(true);
    }
    expect(meshRequests.filter(r => r.method === 'GET')).toHaveLength(originals);
    const exported = await nativeArtifact(b);
    expect(
      exported.cadResources?.some((r) => (r.kind as string) === 'mesh-epm' && r.byteLength > 100),
    ).toBe(true);
    fixture.revoke('recipient');
    await expect(b.getByRole('alert')).toContainText('閲覧権限');
    await expect(b.getByLabel('Character view')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await guest.close();
    await page.context().unrouteAll({ behavior: 'wait' });
    await fixture.close();
  }
});
