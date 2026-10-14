import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, expect, nativeArtifact, setDocumentText } from './fixtures';
import { authorAndInsert, publishRevision, stageRevision } from './reuse-revision-fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';
import { confirmed, saveShared } from './practical-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

async function adopted(page: Page) {
  const before = await authorAndInsert(page);
  await publishRevision(page);
  await reuseMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const preview = await stageRevision(page);
  await preview.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await confirmed(page);
  expect(
    ((await nativeArtifact(page)).draft.content as DocumentContent).reuse!.instances[0].ref.version,
  ).toBe(2);
  return before;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}
async function holdUndo(page: Page) {
  const entered = gate(),
    held = gate(),
    delivered = gate();
  let intercepted = false;
  // Retiring interception during fulfill can strand the next fetch in Chromium;
  // keep the route installed and delay only the first history response.
  await page.route('**/collaboration-api/undo?*', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    entered.release();
    await held.promise;
    await route.fulfill({ response });
    delivered.release();
  });
  await reuseHistory(page, 'Undo');
  await entered.promise;
  return async () => {
    held.release();
    await delivered.promise;
  };
}
for (const scenario of ['new-edit', 'reconnect'] as const)
  test(`R07 linked update Undo ${scenario} retains native history and version save`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    const before = await adopted(page),
      bodyId = before.blocks.find((b) => b.type === 'paragraph')!.id,
      bodyText = (value: DocumentContent) => value.blocks.find((b) => b.id === bodyId)!.text,
      release = await holdUndo(page);
    try {
      if (scenario === 'new-edit') {
        const receipts: { status: string; code?: string }[] = [];
        const submitted = page.waitForResponse(async (response) => {
          if (
            !response.url().includes('/collaboration-api/submit?') ||
            response.request().method() !== 'POST'
          )
            return false;
          const receipt = await response.json();
          receipts.push(receipt);
          return receipt.status === 'accepted';
        });
        await setDocumentText(page, `[data-block-id="${bodyId}"]`, 'Undo応答中の新しい案件本文');
        expect((await (await submitted).json()).status).toBe('accepted');
        // A text operation prepared before the independent inverse may need one
        // ordinary engine-version rebase. The retained edit must then be accepted.
        expect(receipts.every((r) => r.status === 'accepted' || r.code === 'resync-required')).toBe(
          true,
        );
        await writeFile(
          info.outputPath('new-edit-receipts.json'),
          JSON.stringify(receipts, null, 2),
        );
        await expect(page.locator('.save-status')).toContainText('1 pending');
      } else {
        await reuseMenu(page, 'Pause transport (reference)');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('alert')).toContainText('Disconnected: pending edits retained');
      }
    } finally {
      await release();
    }
    if (scenario === 'reconnect') {
      await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
      await reuseMenu(page, 'Resume transport (reference)');
      await page.keyboard.press('Escape');
    }
    try {
      await confirmed(page);
    } catch (error) {
      const checkpoint = page.waitForEvent('download');
      await reuseMenu(page, 'Export pending checkpoint');
      await (await checkpoint).saveAs(info.outputPath('pending-checkpoint.json'));
      throw error;
    }
    const undone = (await nativeArtifact(page)).draft.content as DocumentContent;
    expect(undone.reuse!.instances[0].ref.version).toBe(1);
    if (scenario === 'new-edit') {
      expect(bodyText(undone)).toBe('Undo応答中の新しい案件本文');
      await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
      await reuseHistory(page, 'Undo');
      await confirmed(page);
      expect(bodyText((await nativeArtifact(page)).draft.content as DocumentContent)).toBe(
        bodyText(before),
      );
      await reuseHistory(page, 'Redo');
      await confirmed(page);
      expect((await nativeArtifact(page)).draft.content).toEqual(undone);
    }
    if (await page.getByRole('button', { name: 'Dismiss error', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await saveShared(page, 1);
    const saved = await nativeArtifact(page);
    expect((saved.versions[0].content as DocumentContent).reuse!.instances[0].ref.version).toBe(1);
    await page.reload();
    await confirmed(page);
    expect((await nativeArtifact(page)).draft.content).toEqual(saved.draft.content);
    await writeFile(info.outputPath(`${scenario}.artifact.json`), JSON.stringify(saved, null, 2));
    await page.screenshot({ path: info.outputPath(`${scenario}.png`), fullPage: true });
  });
