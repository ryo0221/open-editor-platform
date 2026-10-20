import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createArtifact, commitVersion, type Artifact } from '@editor-platform/artifact-core';
import type { AnimationHostContent } from '@editor-platform/animation-core/v2';
import { animationLayerActionsFixture } from '../fixtures/animation-layer-actions';
import { test, expect, nativeArtifact, save } from './fixtures';

const duplicateName = 'Duplicate layers';
const deleteName = 'Delete layers…';
test('deleting the initially selected final layer leaves keyboard focus on Add rectangle', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4189');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const original = (await native(page, true)).draft.content;
  await page.getByRole('button', { name: deleteName, exact: true }).click();
  await page.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Animation layers', exact: true }).getByRole('button'),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: duplicateName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: deleteName, exact: true })).toBeDisabled();
  await history(page, 'Undo', true);
  expect(
    (await native(page, true)).draft.content.compositions[0].layers.map((layer) => layer.id),
  ).toEqual(original.compositions[0].layers.map((layer) => layer.id));
});
async function importMotion(page: Page, independent = false) {
  const record = await commitVersion(
    createArtifact('animation', 'Layer actions motion', animationLayerActionsFixture()),
    'test',
    'Original',
  );
  await page.goto(independent ? 'http://127.0.0.1:4189' : '/');
  const input = page.getByLabel(independent ? 'Import Animation native' : 'Import artifact', {
    exact: true,
  });
  if (!independent && !(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: 'motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...record, annotations: [] })),
  });
  await page.getByRole('button', { name: 'Animation を新しい形式へ変換', exact: true }).click();
  await expect(page.locator('[data-layer-id="group"] button')).toBeVisible();
  const close = page.getByRole('button', { name: 'Close library panel', exact: true });
  if (!independent && (await close.isVisible())) await close.click();
}
async function native(page: Page, independent = false): Promise<Artifact<AnimationHostContent>> {
  if (!independent) return (await nativeArtifact(page)) as Artifact<AnimationHostContent>;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8'));
}
async function history(page: Page, direction: 'Undo' | 'Redo', independent = false) {
  const button = page.getByRole('button', { name: direction, exact: true });
  if (!independent && !(await button.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await button.click();
  if (!independent) await page.keyboard.press('Escape');
}

for (const independent of [false, true])
  test(`${independent ? 'independent' : 'ordinary'} Animation duplicates/deletes complete subtrees, preserves history and reloads saved motion`, async ({
    page,
  }, info) => {
    await importMotion(page, independent);
    const before = await native(page, independent);
    await page.locator('[data-layer-id="group"] button').click();
    await page.getByRole('button', { name: duplicateName, exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: 'Animation layers', exact: true })
        .locator('button[aria-pressed="true"]'),
    ).toBeFocused();
    const copied = await native(page, independent),
      c = copied.draft.content.compositions[0];
    expect(c.layers).toHaveLength(9);
    expect(c.tracks).toHaveLength(5);
    expect(c.layers.slice(0, 6)).toEqual(before.draft.content.compositions[0].layers);
    expect(c.tracks.slice(0, 3)).toEqual(before.draft.content.compositions[0].tracks);
    expect(copied.versions).toEqual(before.versions);
    expect(copied.draft.content.compositions[1]).toEqual(before.draft.content.compositions[1]);
    const [child, inner, group] = c.layers.slice(6);
    expect([child.parentId, inner.parentId, group.parentId]).toEqual([
      inner.id,
      group.id,
      'parent',
    ]);
    expect(
      new Set([
        ...c.layers.map((l) => l.id),
        ...c.tracks.flatMap((t) => [t.id, ...t.keys.map((k) => k.id)]),
      ]).size,
    ).toBe(24);
    const selected = page.locator(`[data-layer-id="${group.id}"] button`);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Animation playhead', { exact: true }).fill('480000');
    const rects = page.locator('.a2-stage .animation-player2 svg rect');
    await expect(rects).toHaveCount(4);
    expect(await rects.last().getAttribute('transform')).toBe(
      await rects.first().getAttribute('transform'),
    );
    expect(await rects.last().getAttribute('opacity')).toBe(
      await rects.first().getAttribute('opacity'),
    );
    await history(page, 'Undo', independent);
    expect((await native(page, independent)).draft.content).toEqual(before.draft.content);
    await history(page, 'Redo', independent);
    expect((await native(page, independent)).draft.content).toEqual(copied.draft.content);
    await selected.click();
    await page.getByRole('button', { name: deleteName, exact: true }).click();
    const confirmation = page.getByRole('group', {
      name: 'Delete layer confirmation',
      exact: true,
    });
    await expect(confirmation).toContainText('Delete 3 layers, 2 tracks and 4 keys?');
    await expect(confirmation.getByRole('listitem')).toHaveCount(3);
    await page.screenshot({
      path: info.outputPath(`${independent ? 'independent' : 'ordinary'}-delete-review.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Cancel layer deletion', exact: true }).click();
    expect((await native(page, independent)).draft.content).toEqual(copied.draft.content);
    await page.getByRole('button', { name: deleteName, exact: true }).click();
    await page.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
    const deleted = await native(page, independent);
    expect(deleted.draft.content).toEqual(before.draft.content);
    expect(deleted.versions).toEqual(before.versions);
    await history(page, 'Undo', independent);
    expect((await native(page, independent)).draft.content).toEqual(copied.draft.content);
    await history(page, 'Redo', independent);
    expect((await native(page, independent)).draft.content).toEqual(deleted.draft.content);
    await page.locator('[data-layer-id="group"] button').click();
    await page.getByRole('button', { name: duplicateName, exact: true }).click();
    const finalContent = (await native(page, independent)).draft.content;
    if (independent) {
      await page.getByRole('button', { name: 'Save version', exact: true }).click();
      await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('2');
    } else await save(page, 2);
    const saved = await native(page, independent);
    expect(saved.versions).toHaveLength(2);
    expect(saved.versions[0]).toEqual(before.versions[0]);
    expect(saved.draft.content).toEqual(finalContent);
    if (independent) {
      await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
    } else await page.reload();
    expect((await native(page, independent)).draft.content).toEqual(finalContent);
    await expect(page.locator('.a2-stage .animation-player2 svg rect')).toHaveCount(4);
    if (independent) {
      await page.getByRole('button', { name: 'View saved Player', exact: true }).click();
      await expect(
        page.getByRole('img', { name: saved.name, exact: true }).locator('rect'),
      ).toHaveCount(4);
      await page.getByRole('button', { name: 'Edit Animation', exact: true }).click();
      expect((await native(page, independent)).draft.content).toEqual(finalContent);
    }
  });

test('independent Animation protects pending/IME/read-only input and stale deletion reviews', async ({
  page,
}, info) => {
  await importMotion(page, true);
  await page.locator('[data-layer-id="group"] button').click();
  const before = await native(page, true);
  const duplicate = page.getByRole('button', { name: duplicateName, exact: true });
  const remove = page.getByRole('button', { name: deleteName, exact: true });
  const x = page.getByLabel('Base x', { exact: true });
  await x.fill('invalid');
  await expect(duplicate).toBeDisabled();
  await expect(remove).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  await x.dispatchEvent('compositionstart');
  await expect(duplicate).toBeDisabled();
  await expect(remove).toBeDisabled();
  await x.dispatchEvent('compositionend');
  await expect(duplicate).toBeEnabled();
  await expect(remove).toBeEnabled();
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(duplicate).toBeDisabled();
  await expect(remove).toBeDisabled();
  await page.getByLabel('Read only', { exact: true }).uncheck();
  expect((await native(page, true)).draft.content).toEqual(before.draft.content);
  await remove.click();
  await x.fill('120');
  await expect(
    page.getByRole('button', { name: 'Confirm layer deletion', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(
    page.getByText('Animation changed. Cancel and review the layers again.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm layer deletion', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: info.outputPath('stale-delete-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel layer deletion', exact: true }).click();
  await remove.click();
  await page.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
  const removed = (await native(page, true)).draft.content;
  expect(removed.compositions[0].layers.map((l) => l.id)).toEqual(['outside', 'parent', 'sibling']);
  await history(page, 'Undo', true);
  await page.locator('[data-layer-id="group"] button').click();
  await expect(x).toHaveValue('120');
  expect((await native(page, true)).versions).toEqual(before.versions);
});

test('ordinary Animation disables layer mutations for the full asynchronous version save', async ({
  page,
}) => {
  await importMotion(page);
  await page.locator('[data-layer-id="group"] button').click();
  const before = await native(page);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      crypto.subtle.digest = digest;
      document.documentElement.dataset.animationSaveWaiting = 'true';
      await new Promise<void>((resolve) =>
        window.addEventListener('release-animation-save', () => resolve(), { once: true }),
      );
      return digest(...args);
    };
  });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-animation-save-waiting', 'true');
  await expect(page.getByRole('button', { name: duplicateName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: deleteName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('release-animation-save')));
  await expect(page.getByRole('button', { name: duplicateName, exact: true })).toBeEnabled();
  const after = await native(page);
  expect(after.draft.content).toEqual(before.draft.content);
  expect(after.versions).toHaveLength(before.versions.length + 1);
  expect(after.versions.at(-1)!.content).toEqual(before.draft.content);
});
