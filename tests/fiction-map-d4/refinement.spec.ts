import { test, expect, nativeArtifact } from '../e2e/fixtures';
import { commitVersion } from '@editor-platform/artifact-core';
import { settingDemoArtifact, settingDemoContent } from '../../scripts/fixtures/fiction-map-demo';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import type { Page } from '@playwright/test';
async function candidate(page: Page, stage: 'terrain' | 'detailed') {
  const details = page.locator('.fm-native-input');
  if (!(await details.getByLabel('Refinement native JSON').isVisible()))
    await details.locator('summary').click();
  await details.getByLabel('Refinement native JSON').setInputFiles({
    name: `${stage}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(settingDemoContent(stage))),
  });
  await expect(details.getByAltText('Map refinement preview')).toBeVisible();
  return details;
}
async function history(page: Page, name: 'Undo' | 'Redo') {
  const button = page.getByRole('button', { name, exact: true }).first();
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await button.click();
  await page.keyboard.press('Escape');
}
test('rough → terrain → detailed remains one Artifact with stable IDs, preview/input guard and one-command Undo', async ({
  page,
}, info) => {
  await page.goto('/');
  const rough = await commitVersion(settingDemoArtifact('rough'), null, 'Rough layout');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'rough.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(rough)),
  });
  const before = await nativeArtifact(page);
  const form = await candidate(page, 'terrain');
  await expect(page.locator('[data-fiction-feature]')).toHaveCount(19);
  await page.getByLabel('Named document view', { exact: true }).fill('Pending view');
  await form.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('other map inputs');
  await expect(page.locator('[data-fiction-feature]')).toHaveCount(19);
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  await form.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
  const terrain = await nativeArtifact(page);
  expect(terrain.id).toBe(before.id);
  expect(terrain.draft.content).toEqual(settingDemoContent('terrain'));
  expect(terrain.versions).toEqual(before.versions);
  await history(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await history(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(terrain.draft.content);
  await candidate(page, 'detailed');
  await form.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
  const detailed = await nativeArtifact(page);
  expect(detailed.id).toBe(before.id);
  expect(detailed.draft.content).toEqual(settingDemoContent('detailed'));
  const native = detailed.draft.content as FictionMapContent;
  for (const f of rough.draft.content.features) {
    expect(native.features.find((n) => n.id === f.id)).toBeDefined();
  }
  expect(native.features.find((f) => f.id === 'new-port')!.worldEntityRef).toEqual(
    rough.draft.content.features.find((f) => f.id === 'new-port')!.worldEntityRef,
  );
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await page
    .getByRole('application', { name: 'Fiction Map canvas' })
    .screenshot({ path: `/tmp/fiction-map-d4/refined-map-${info.project.name}.png` });
});

test('pending refinement rejects stale, corrupt and oversized candidates without rolling back external native or history', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4192/d3.html');
  const form = await candidate(page, 'terrain');
  const unchanged = await page.getByTestId('native').textContent();
  await page.getByRole('button', { name: 'External rename', exact: true }).click();
  const updated = await page.getByTestId('native').textContent();
  expect(updated).not.toBe(unchanged);
  const version = await page.getByTestId('revision').textContent();
  const historyBefore = await page.getByTestId('source-history').textContent();
  const versionsBefore = await page.getByTestId('versions').textContent();
  await form.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'stale-revision' }).first()).toBeVisible();
  expect(await page.getByTestId('native').textContent()).toBe(updated);
  expect(await page.getByTestId('revision').textContent()).toBe(version);
  expect(await page.getByTestId('source-history').textContent()).toBe(historyBefore);
  expect(await page.getByTestId('versions').textContent()).toBe(versionsBefore);
  await form.getByRole('button', { name: 'Cancel map refinement', exact: true }).click();
  await candidate(page, 'terrain');
  await page.getByRole('button', { name: 'Toggle permission', exact: true }).click();
  await expect(
    form.getByRole('button', { name: 'Apply map refinement', exact: true }),
  ).toBeDisabled();
  await expect(form.getByLabel('Refinement native JSON')).toBeDisabled();
  expect(await page.getByTestId('native').textContent()).toBe(updated);
  expect(await page.getByTestId('revision').textContent()).toBe(version);
  expect(await page.getByTestId('source-history').textContent()).toBe(historyBefore);
  expect(await page.getByTestId('versions').textContent()).toBe(versionsBefore);
  await form.getByRole('button', { name: 'Cancel map refinement', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle permission', exact: true }).click();
  for (const [name, body, code] of [
    ['corrupt', '{"kind":"fiction-map","kind":"fiction-map"}', 'invalid-json'],
    ['oversize', ' '.repeat(65537), 'input-byte-limit'],
  ] as const) {
    await form.getByLabel('Refinement native JSON').setInputFiles({
      name: name + '.json',
      mimeType: 'application/json',
      buffer: Buffer.from(body),
    });
    await expect(page.getByRole('alert').first()).toContainText(code);
    await expect(
      form.getByRole('button', { name: 'Apply map refinement', exact: true }),
    ).toBeDisabled();
    expect(await page.getByTestId('native').textContent()).toBe(updated);
    expect(await page.getByTestId('revision').textContent()).toBe(version);
    expect(await page.getByTestId('source-history').textContent()).toBe(historyBefore);
    expect(await page.getByTestId('versions').textContent()).toBe(versionsBefore);
  }
  // A delayed File.text completion cannot revive a cancelled candidate.
  await form.getByLabel('Refinement native JSON').evaluate(
    (node, content) => {
      const file = new File([content], 'delayed.json', { type: 'application/json' });
      Object.defineProperty(file, 'text', {
        value: () =>
          new Promise<string>((resolve) => {
            Object.assign(window, { releaseMapCandidate: () => resolve(content) });
          }),
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      (node as HTMLInputElement).files = transfer.files;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    },
    JSON.stringify(settingDemoContent('terrain')),
  );
  await expect(form.getByRole('status')).toContainText('候補を検証しています');
  await form.getByRole('button', { name: 'Cancel map refinement', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseMapCandidate(): void }).releaseMapCandidate(),
  );
  await expect(form.getByAltText('Map refinement preview')).toHaveCount(0);
  await expect(
    form.getByRole('button', { name: 'Apply map refinement', exact: true }),
  ).toBeDisabled();
  expect(await page.getByTestId('native').textContent()).toBe(updated);
  expect(await page.getByTestId('revision').textContent()).toBe(version);
  expect(await page.getByTestId('source-history').textContent()).toBe(historyBefore);
});
