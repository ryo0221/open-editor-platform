import { build } from 'esbuild';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// #401: an independent Host built from public entrypoints only (no Playground code).
let bundle: Promise<string>;
async function host(page: Page) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/proposal-review/host.tsx'],
    bundle: true,
    write: false,
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => r.outputFiles[0].text);
  const js = await bundle;
  await page.route('**/proposal-review-host.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: js }),
  );
  await page.route('**/proposal-review-host', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/proposal-review-host.js"></script>',
    }),
  );
  await page.goto('/proposal-review-host');
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const content = async (page: Page) =>
  JSON.parse((await page.getByTestId('host-content').textContent())!);
const changes = (page: Page) =>
  page.getByRole('list', { name: 'Content changes' }).getByRole('listitem');
const refusal = (page: Page) => page.getByRole('alert');

export function proposalReviewHostCases() {
  test('independent Host: Document text range, preview keeps the draft, reject and apply', async ({
    page,
  }, info) => {
    await host(page);
    const before = await content(page);
    await button(page, 'Request proposal').click();
    await expect(changes(page)).toHaveText([
      'Ship on Friday.\nThen review. [body] text text (utf16): "Ship on Friday.\\nThen review." → "Ship on Monday.\\nThen review."',
    ]);
    expect(await content(page)).toEqual(before);
    await page.screenshot({ path: info.outputPath('host-document.png'), fullPage: true });
    await button(page, 'Host reject').click();
    expect(await content(page)).toEqual(before);
    await button(page, 'Request proposal').click();
    await button(page, 'Host apply').click();
    expect((await content(page)).blocks[1].text).toBe('Ship on Monday.\nThen review.');
    await button(page, 'Host undo').click();
    expect(await content(page)).toEqual(before);
  });

  test('independent Host: Data, Whiteboard and Schedule changes in their own units', async ({
    page,
  }, info) => {
    await host(page);
    await page.getByLabel('Host domain').selectOption('data');
    await button(page, 'Request proposal').click();
    await expect(changes(page)).toHaveText([
      'Design [task-design] period Start – End (iso-date): {"start":"2026-10-05","end":"2026-10-09"} → {"start":"2026-10-12","end":"2026-10-16"}',
      'Design [task-design] field Status: "Planned" → "Active"',
    ]);
    await expect(
      page.getByRole('list', { name: 'Display changes' }).getByRole('listitem'),
    ).toHaveCount(0);
    await page.getByLabel('Host domain').selectOption('whiteboard');
    await button(page, 'Request proposal').click();
    await expect(changes(page)).toHaveText([
      'Risks [note-risks] move bounds (board-px): {"x":120,"y":120,"width":180,"height":120} → {"x":200,"y":160,"width":180,"height":120}',
    ]);
    await page.getByLabel('Host domain').selectOption('schedule');
    await button(page, 'Request proposal').click();
    await expect(changes(page)).toHaveText([
      /^Design review \[review\] period time \(Asia\/Tokyo\): .*"startLocal":"2026-10-26T10:00".* → .*"startLocal":"2026-10-26T11:00".*"timeZone":"Asia\/Tokyo"/,
    ]);
    const before = await content(page);
    await button(page, 'Request unknown-zone proposal').click();
    await expect(refusal(page)).toHaveAttribute('data-reason', 'unknown-units');
    await expect(changes(page)).toHaveCount(0);
    await expect(button(page, 'Host apply')).toBeDisabled();
    expect(await content(page)).toEqual(before);
    await page.screenshot({ path: info.outputPath('host-unknown-zone.png'), fullPage: true });
  });

  test('independent Host: stale version, changed draft, deleted target and unsupported domain', async ({
    page,
  }, info) => {
    await host(page);
    await button(page, 'Request proposal').click();
    await button(page, 'Host save version').click();
    await button(page, 'Check proposal again').click();
    await expect(refusal(page)).toHaveAttribute('data-reason', 'stale-version');
    await expect(button(page, 'Host apply')).toBeDisabled();
    await button(page, 'Request proposal').click();
    await expect(refusal(page)).toHaveCount(0);
    await button(page, 'Host delete target').click();
    await button(page, 'Check proposal again').click();
    await expect(refusal(page)).toHaveAttribute('data-reason', 'stale-draft');
    await button(page, 'Request proposal').click();
    await expect(refusal(page)).toHaveAttribute('data-reason', 'missing-target');
    await expect(page.getByText('Items: body', { exact: true })).toBeVisible();
    await page.getByLabel('Host domain').selectOption('geo');
    const geo = await content(page);
    await button(page, 'Request proposal').click();
    await expect(refusal(page)).toHaveAttribute('data-reason', 'unsupported-domain');
    await expect(page.getByLabel('JSON fallback')).toContainText('EPSG:6677');
    await expect(changes(page)).toHaveCount(0);
    await expect(button(page, 'Host apply')).toBeDisabled();
    expect(await content(page)).toEqual(geo);
    await page.screenshot({ path: info.outputPath('host-unsupported.png'), fullPage: true });
  });
}
