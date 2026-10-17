import { test, expect, create, nativeArtifact, setDocumentText } from './fixtures';
import { reuseMenu } from './reuse-fixtures';
import { reuseSharedHistory } from './reuse-shared-history-fixture';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('shared history confirmation precedes native export even after content has synchronized', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'document');
  await setDocumentText(page, 'p', 'Before undo');
  await reuseMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  const original = (await nativeArtifact(page)).draft.content;
  await setDocumentText(page, 'p', 'After edit');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  const edited = (await nativeArtifact(page)).draft.content;
  expect(edited).not.toEqual(original);
  const entered = gate(),
    held = gate(),
    delivered = gate();
  let intercepted = false;
  await page.route('**/collaboration-api/undo?*', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    expect((await response.json()).status).toBe('accepted');
    entered.release();
    await held.promise;
    await route.fulfill({ response });
    delivered.release();
  });
  let completed = false;
  let captured = false;
  let capture: Promise<Awaited<ReturnType<typeof nativeArtifact>>> | undefined;
  const history = reuseSharedHistory(page, 'Undo').then(() => {
    completed = true;
  });
  // Attach immediately so a failed confirmation assertion never becomes unhandled.
  void history.catch(() => {});
  try {
    await entered.promise;
    await expect(page.locator('.ProseMirror p')).toHaveText('Before undo');
    await expect(page.locator('.save-status')).toContainText('1 pending');
    // Content synchronization is insufficient: the accepted receipt is still held.
    expect(completed, 'history helper must not finish before its receipt').toBe(false);
    capture = nativeArtifact(page).then((record) => {
      captured = true;
      return record;
    });
    void capture.catch(() => {});
    await expect(page.getByRole('dialog', { name: 'Export artifact', exact: true })).toBeVisible();
    expect(captured, 'native read must not finish before the history receipt').toBe(false);
  } finally {
    held.release();
    await delivered.promise;
  }
  await history;
  expect((await capture!).draft.content).toEqual(original);
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await reuseSharedHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(edited);
});
