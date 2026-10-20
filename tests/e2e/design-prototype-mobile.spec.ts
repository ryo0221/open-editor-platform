import { test, expect } from './fixtures';
import {
  independentPrototype,
  followPrototype,
  assertStyledPrototypeVisibility,
  assertStyledPrototypeTransform,
} from './design-prototype-fixtures';

test('#27 mobile styled composite transforms keep visible geometry clickable and annotatable', async ({
  page,
}, info) => {
  await assertStyledPrototypeTransform(page, info);
});

test('#27 mobile styled hidden prototype frames reject navigation and stay out of the start picker', async ({
  page,
}, info) => {
  await assertStyledPrototypeVisibility(page, info);
});
test('mobile taps complete five frames including a centered overlay with no native edit', async ({
  page,
}, info) => {
  await independentPrototype(page);
  expect(await page.evaluate(() => innerWidth)).toBe(390);
  const bytes = await page.getByTestId('prototype-source').textContent();
  await page.getByRole('button', { name: 'Show hotspots', exact: true }).tap();
  await page.getByLabel('Prototype flow', { exact: true }).selectOption('happy');
  await page.getByRole('button', { name: 'Activate Continue', exact: true }).tap();
  await page.getByRole('button', { name: 'Activate Show state', exact: true }).tap();
  await page.getByRole('button', { name: 'Activate Open dialog', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: 'Overlay Dialog', exact: true })).toBeVisible();
  const box = await page.getByRole('dialog', { name: 'Overlay Dialog', exact: true }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('prototype-mobile-overlay.png') });
  await page.getByRole('button', { name: 'Activate Close dialog', exact: true }).tap();
  await followPrototype(page, true);
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('status'),
  ).toContainText('Completed');
  await expect(page.getByLabel('Host flow completions')).toHaveText('1');
  await expect(page.getByTestId('prototype-source')).toHaveText(bytes!);
  await page.screenshot({ path: info.outputPath('prototype-mobile-done.png') });
});

test('mobile ordinary Host prototype dialog fits the viewport and completes the flow', async ({
  page,
}, info) => {
  const { create, nativeArtifact } = await import('./fixtures');
  const { prototypeFixture } = await import('../fixtures/design-prototype/content');
  await page.goto('/');
  await create(page, 'design');
  const record = await nativeArtifact(page);
  record.draft.content = prototypeFixture();
  if ((await page.getByLabel('Import artifact', { exact: true }).count()) === 0)
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'mobile-prototype.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design prototype', exact: true });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await followPrototype(page, true);
  await expect(
    page.getByRole('region', { name: 'Design prototype', exact: true }).getByRole('status'),
  ).toContainText('Completed');
  expect(await page.evaluate(() => innerWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('normal-mobile-prototype.png') });
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(record.draft.content);
});
