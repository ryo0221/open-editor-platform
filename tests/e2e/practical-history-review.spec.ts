import type { Page } from '@playwright/test';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { StructuredData } from '@editor-platform/structured-data';
import { test, expect, create, addRecord, editCell, artifactView } from './fixtures';
import { artifactMenu } from './template-fixtures';
import { confirmed, saveShared, screenshot } from './practical-fixtures';

async function menu(page: Page, name: string) {
  await artifactMenu(page, name);
  await page.keyboard.press('Escape');
}
async function openData(page: Page) {
  await page.goto('/');
  await create(page, 'data');
  await addRecord(page);
  await menu(page, 'Open collaboratively');
  await confirmed(page);
  await editCell(page, 'Quantity', 1, '11');
  await confirmed(page);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function holdUndo(page: Page) {
  const entered = gate(),
    held = gate(),
    delivered = gate();
  let intercepted = false;
  // Keep interception installed until the context closes. Retiring a times: 1
  // route while fulfilling its response can strand the immediately following
  // fetch in Chromium, independently of Editor history (retained reproduction).
  await page.route('**/collaboration-api/undo?*', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    entered.release();
    await held.promise;
    await route.fulfill({ response });
    delivered.release();
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await entered.promise;
  return async () => {
    held.release();
    await delivered.promise;
  };
}
const cell = (page: Page, name: string) =>
  page.getByRole('gridcell', { name: `${name} · record 1`, exact: true });

async function retainedData(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('editor-platform-reference-recovery', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<
        ReturnType<SharedEditorSession<StructuredData>['checkpoint']> | undefined
      >((resolve, reject) => {
        const request = db
          .transaction('checkpoints')
          .objectStore('checkpoints')
          .index('namespace')
          .getAll(sessionStorage.getItem('ep-recovery-namespace')!);
        request.onsuccess = () =>
          resolve(
            request.result.find((entry: { location: string }) => entry.location.endsWith(':A'))
              ?.checkpoint,
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test('R6-01: a cell edit during a delayed Undo keeps its history and invalidates old Redo', async ({
  page,
}) => {
  await openData(page);
  const release = await holdUndo(page);
  try {
    const submitted = page.waitForResponse(
      (r) => r.url().includes('/collaboration-api/submit?') && r.request().method() === 'POST',
    );
    await editCell(page, 'Price', 1, '22');
    expect((await (await submitted).json()).status).toBe('accepted');
    await expect(cell(page, 'Price')).toHaveText('22');
    // Only the held history request remains: the new edit has entered Undo history.
    await expect(page.locator('.save-status')).toContainText('1 pending');
  } finally {
    await release();
  }
  await confirmed(page);
  await expect(cell(page, 'Quantity')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('10');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('22');
  await expect(cell(page, 'Quantity')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await screenshot(page, 'history-delayed-undo-new-edit');
});

test('R6-02: a failed Undo synchronization recovers save and restore after reconnect', async ({
  page,
}) => {
  await openData(page);
  const release = await holdUndo(page);
  try {
    await menu(page, 'Pause transport (reference)');
    // Wait until an existing poll has settled in the disconnected state. The
    // history receipt cannot accidentally join a successful older poll after release.
    await expect(page.getByRole('alert')).toContainText('Disconnected: pending edits retained');
  } finally {
    await release();
  }
  // The history call itself must fail, not merely an unrelated background poll.
  await expect(page.getByRole('alert')).toContainText('Disconnected: pending edits retained');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await menu(page, 'Resume transport (reference)');
  await confirmed(page);
  await expect(cell(page, 'Quantity')).toHaveText('1');
  if (await page.getByRole('button', { name: 'Dismiss error', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await saveShared(page, 1);
  await editCell(page, 'Price', 1, '22');
  await confirmed(page);
  await artifactView(page, 'History');
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  await artifactView(page, 'Editor');
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('10');
  await expect(cell(page, 'Quantity')).toHaveText('1');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshot(page, 'history-reconnect-save-restore');
});

test('R6-03: asynchronous Host recovery retains offline input through reload and selective Undo', async ({
  page,
}) => {
  await openData(page);
  await menu(page, 'Pause transport (reference)');
  await expect(page.getByRole('alert')).toContainText('Disconnected: pending edits retained');
  await editCell(page, 'Price', 1, '22');
  await screenshot(page, 'recovery-offline-edit');
  await expect(page.locator('.save-status')).toContainText('pending');
  await expect
    .poll(async () => {
      const saved = await retainedData(page);
      return saved?.queue.some((intent) => {
        const price = intent.content.columns.find((column) => column.name === 'Price')!;
        return intent.content.rows[0].values[price.id] === 22;
      });
    })
    .toBe(true);
  // The routine checkpoint exists in IndexedDB, without a large synchronous backup.
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('ep-shared-pending:')),
    ),
  ).toEqual([]);
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('22');
  await expect(cell(page, 'Quantity')).toHaveText('11');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('10');
  await expect(cell(page, 'Quantity')).toHaveText('11');
});

test('R6-04: failed asynchronous recovery is visible, retry retains the edit, and reload restores it', async ({
  page,
}) => {
  await openData(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'checkpoints')
        throw new DOMException('Simulated recovery quota', 'QuotaExceededError');
      return original.call(this, value, key);
    };
    (window as Window & { restoreRecoveryWrites?: () => void }).restoreRecoveryWrites = () => {
      IDBObjectStore.prototype.put = original;
    };
  });
  await editCell(page, 'Price', 1, '22');
  await expect(page.getByRole('alert')).toContainText('Recovery checkpoint could not be saved');
  await expect(cell(page, 'Price')).toHaveText('22');
  await page.evaluate(() =>
    (window as Window & { restoreRecoveryWrites?: () => void }).restoreRecoveryWrites!(),
  );
  await expect
    .poll(async () => {
      const saved = await retainedData(page);
      const content = saved?.client.confirmed.content;
      const price = content?.columns.find((column) => column.name === 'Price');
      return price && content?.rows[0].values[price.id];
    })
    .toBe(22);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('22');
  await saveShared(page, 1);
});

test('R6-05: reload retains new offline input while routine checkpoint preparation is deferred', async ({
  page,
}) => {
  await openData(page);
  await page.evaluate(() => {
    const scope = window as Window & { recoveryIdleWaiting?: boolean };
    window.requestIdleCallback = () => {
      scope.recoveryIdleWaiting = true;
      return 1;
    };
    window.cancelIdleCallback = () => {
      scope.recoveryIdleWaiting = false;
    };
  });
  await menu(page, 'Pause transport (reference)');
  // Input also observes disconnection if an earlier poll is already waiting idle.
  await editCell(page, 'Price', 1, '22');
  await expect(page.getByRole('alert')).toContainText('Disconnected: pending edits retained');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { recoveryIdleWaiting?: boolean }).recoveryIdleWaiting,
      ),
    )
    .toBe(true);
  await expect(page.locator('.save-status')).toContainText('pending');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('22');
  await expect(cell(page, 'Quantity')).toHaveText('11');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(page);
  await expect(cell(page, 'Price')).toHaveText('10');
  await expect(cell(page, 'Quantity')).toHaveText('11');
});
