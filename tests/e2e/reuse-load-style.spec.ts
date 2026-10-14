import { test, expect, create, nativeArtifact } from './fixtures';
import { viewStyleFlow } from './reuse-view-style-fixtures';
import { nativeLoadFixture } from '../fixtures/reuse/native-load';
import { writeFile } from 'node:fs/promises';

for (const domain of ['review', 'file'] as const)
  test(`R12 ${domain} annotation token style draft/reload/removal preserves old annotations and source`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    await viewStyleFlow(page, info, domain);
  });

test('R14 native import rejects hash-valid unsupported retained recipes atomically', async ({
  page,
}, info) => {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'document');
  const before = await nativeArtifact(page),
    { valid, invalid } = await nativeLoadFixture();
  const imported = {
    ...before,
    name: '取り込み検証',
    versions: [],
    draft: { ...before.draft, content: invalid },
  };
  // File controls live in the ordinary artifact action menu.
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toContainText('Import failed:');
  expect(await nativeArtifact(page)).toEqual(before);
  imported.draft.content = valid;
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'valid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('.ProseMirror')).toContainText('採用後に編集した案件本文');
  await page.reload();
  const after = await nativeArtifact(page);
  expect(after.draft.content).toEqual(valid);
  await writeFile(info.outputPath('imported.artifact.json'), JSON.stringify(after, null, 2));
  await page.screenshot({ path: info.outputPath('native-import.png'), fullPage: true });
});
