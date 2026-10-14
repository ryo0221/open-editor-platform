import {
  test,
  expect,
  create,
  nativeArtifact,
  setDocumentText,
  save,
  comments,
  artifactView,
} from './fixtures';
import { createArtifact, commitVersion, contentHash } from '@editor-platform/artifact-core';
import type { WhiteboardContent } from '@editor-platform/whiteboard';
import type { DocumentContent } from '@editor-platform/document';

test('failed local writes remain unsaved and retry preserves the latest edit', async ({ page }) => {
  await page.goto('/');
  await create(page);
  await setDocumentText(page, 'p', 'Persisted before quota failure');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (sessionStorage.getItem('simulateQuota'))
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    sessionStorage.setItem('simulateQuota', 'yes');
  });
  await setDocumentText(page, 'p', 'First unsaved edit');
  await expect(page.getByRole('status').first()).toHaveText('Not saved');
  await expect(page.getByRole('alert')).toContainText('QuotaExceededError');
  await setDocumentText(page, 'p', 'Latest unsaved edit 日本語');
  await expect(page.getByRole('status').first()).toHaveText('Not saved');
  expect((await nativeArtifact(page)).draft.content).toMatchObject({
    blocks: expect.arrayContaining([
      expect.objectContaining({ text: 'Latest unsaved edit 日本語' }),
    ]),
  });
  await page.evaluate(() => sessionStorage.removeItem('simulateQuota'));
  await page.getByRole('button', { name: 'Retry local save', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('Latest unsaved edit 日本語');
});

test('a delayed immutable save keeps newer draft edits and annotations; restore is undoable', async ({
  page,
}) => {
  await page.goto('/');
  await create(page);
  await setDocumentText(page, 'p', 'Snapshot text');
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise<void>((resolve) =>
        window.addEventListener('release-test-digest', () => resolve(), { once: true }),
      );
      return digest(...args);
    };
  });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await setDocumentText(page, 'p', 'Newer draft while snapshot hashes');
  await page.locator('.ProseMirror p').first().click();
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('Keep this annotation independent of content history');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-digest')));
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const saved = await nativeArtifact(page);
  expect(saved.versions).toHaveLength(1);
  expect(
    (saved.versions[0].content as DocumentContent).blocks.some((b) => b.text === 'Snapshot text'),
  ).toBe(true);
  expect(
    (saved.draft.content as DocumentContent).blocks.some(
      (b) => b.text === 'Newer draft while snapshot hashes',
    ),
  ).toBe(true);
  expect(saved.annotations).toHaveLength(1);
  expect(saved.versions[0].contentHash).toBe(await contentHash(saved.versions[0].content));
  await artifactView(page, 'History');
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Snapshot text');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Newer draft while snapshot hashes');
  const restored = await nativeArtifact(page);
  expect(restored.versions).toEqual(saved.versions);
  expect(restored.annotations).toEqual(saved.annotations);
});

test('legacy frame migration edits only the Whiteboard draft and native roundtrip retains immutable hashes and anchors', async ({
  page,
}) => {
  const content: WhiteboardContent = {
    schemaVersion: 2,
    nodes: [
      {
        id: 'legacy-frame',
        kind: 'frame',
        name: 'Legacy Region',
        text: '',
        color: '#eef4ff',
        bounds: { x: -500, y: -400, width: 800, height: 600 },
      },
      {
        id: 'stable-note',
        kind: 'sticky',
        groupId: 'legacy-frame',
        text: 'Keep my identity',
        color: '#ffdd88',
        bounds: { x: -400, y: -300, width: 200, height: 120 },
      },
    ],
    connectors: [],
  };
  const source = {
    ...(await commitVersion(
      createArtifact('whiteboard', 'Legacy board', content),
      'test',
      'Before migration',
    )),
    annotations: [],
  };
  await page.goto('/');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({
      name: 'Legacy board.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(source)),
    });
  await page.getByRole('button', { name: 'Go to Section Legacy Region', exact: true }).click();
  const width = page.getByLabel('Section width', { exact: true });
  await width.fill('1000');
  await width.press('Enter');
  const migrated = await nativeArtifact(page);
  const board = migrated.draft.content as WhiteboardContent;
  expect(board.schemaVersion).toBe(3);
  expect(board.sections?.[0].id).toBe('legacy-frame');
  expect(board.nodes[0]).toMatchObject({
    id: 'stable-note',
    sectionId: 'legacy-frame',
    bounds: content.nodes[1].bounds,
  });
  expect(migrated.versions[0].content).toEqual(source.versions[0].content);
  expect(migrated.versions[0].contentHash).toBe(source.versions[0].contentHash);
  await save(page, 2);
  const native = await nativeArtifact(page);
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({
      name: 'Roundtrip.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(native)),
    });
  const roundtrip = await nativeArtifact(page);
  expect(roundtrip.id).not.toBe(native.id);
  expect(roundtrip.draft).toEqual(native.draft);
  expect(roundtrip.versions.map((v) => [v.versionId, v.content, v.contentHash])).toEqual(
    native.versions.map((v) => [v.versionId, v.content, v.contentHash]),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Go to Section Legacy Region', exact: true }),
  ).toBeVisible();
});
