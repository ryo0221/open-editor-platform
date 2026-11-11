import { expect, test, type Page } from '@playwright/test';

/** Edits this Host's IndexedDB package store directly, as damage or a crash would. */
async function editStore(page: Page, edit: 'corrupt' | 'stage-leftover') {
  await page.evaluate(
    (edit) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('extension-reference.packages');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['active', 'staged'], 'readwrite');
          const active = tx.objectStore('active');
          const get = active.get('example.counter@0.0.1');
          get.onsuccess = () => {
            const record = get.result;
            if (edit === 'corrupt') {
              record.files[0].bytes[0] ^= 1;
              active.put(record, 'example.counter@0.0.1');
            } else {
              tx.objectStore('staged').put(
                { ...record, manifest: { ...record.manifest, version: '9.9.9' } },
                'leftover',
              );
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    edit,
  );
}

test('retains verified packages and reopens them from retained bytes after a restart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const status = page.getByLabel('Package retention');
  await page.goto('/');
  await expect(status).toHaveText('Packages: 0.0.1 retained, 0.0.2 retained');
  const value = page.getByLabel('Counter value');
  await expect(value).toHaveText('0');
  // Restart: the same exact pins reopen from this browser's retained bytes.
  await page.reload();
  await expect(status).toHaveText('Packages: 0.0.1 restored, 0.0.2 restored');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(value).toHaveText('1');
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(page.getByLabel('Installed fixture')).toContainText('Fixture 0.0.2');
  await expect(value).toHaveText('1');
  expect(errors).toEqual([]);
});

test('discards an interrupted install on start and keeps the active packages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Package retention')).toContainText('0.0.1 retained');
  await editStore(page, 'stage-leftover');
  await page.reload();
  await expect(page.getByLabel('Package retention')).toHaveText(
    'Packages: discarded 1 interrupted install, 0.0.1 restored, 0.0.2 restored',
  );
  await expect(page.getByLabel('Counter value')).toHaveText('0');
});

test('refuses a damaged retained package instead of replacing it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByLabel('Package retention')).toContainText('0.0.1 retained');
  await editStore(page, 'corrupt');
  await page.reload();
  await expect(page.locator('#status')).toContainText(
    'Bundle verification failed: PackageRetentionError: Retained example.counter@0.0.1 is not intact',
  );
  await expect(page.locator('#surface')).toBeEmpty();
  await page.reload();
  await expect(page.locator('#status')).toContainText('is not intact');
  // Only an explicit repair replaces it, with this build's copy verified against the same pin.
  await page.getByRole('button', { name: 'Repair damaged packages from this build' }).click();
  await expect(page.getByLabel('Package retention')).toHaveText(
    'Packages: 0.0.1 restored, 0.0.2 restored',
  );
  await expect(page.getByLabel('Counter value')).toHaveText('0');
  await expect(
    page.getByRole('button', { name: 'Repair damaged packages from this build' }),
  ).toBeHidden();
  expect(errors).toEqual([]);
});

test('removes a retained package only when nothing needs it, and keeps it removed', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const retention = page.getByLabel('Package retention');
  const status = page.locator('#status');
  const value = page.getByLabel('Counter value');
  const remove = page.getByRole('button', { name: 'Remove retained package', exact: true });
  const retain = page.getByRole('button', { name: 'Retain package', exact: true });
  const select = page.locator('#package-version');
  await page.goto('/');
  await expect(retention).toHaveText('Packages: 0.0.1 retained, 0.0.2 retained');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Needed: the open Editor, and this Host's start-up Editor.
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await remove.click();
  await expect(status).toHaveText('example.counter@0.0.2 is still needed by: open Editor 0.0.2');
  await select.selectOption('0.0.1');
  await remove.click();
  await expect(status).toHaveText('example.counter@0.0.1 is still needed by: start-up Editor');

  // Uninstall keeps the package; once nothing needs it, removal succeeds.
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await select.selectOption('0.0.2');
  await remove.click();
  await expect(status).toHaveText('Removed package 0.0.2; saved drafts and versions unchanged');
  await expect(retention).toHaveText('Packages: 0.0.1 kept, 0.0.2 removed');
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(status).toHaveText('Fixture 0.0.2 is not available');

  // Restart: the build copy is not admitted again; the saved draft is unchanged.
  await page.reload();
  await expect(retention).toHaveText('Packages: 0.0.1 restored, 0.0.2 removed');
  await page.getByRole('button', { name: 'Reload saved draft', exact: true }).click();
  await expect(value).toHaveText('1');
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(status).toHaveText('Fixture 0.0.2 is not available');

  // Explicitly retaining it again re-verifies the build copy against the same pin.
  await retain.click();
  await expect(status).toHaveText('Retained package 0.0.2');
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(page.getByLabel('Installed fixture')).toContainText('Fixture 0.0.2');
  await expect(value).toHaveText('1');
  await page.reload();
  await expect(retention).toHaveText('Packages: 0.0.1 restored, 0.0.2 restored');
  expect(errors).toEqual([]);
});

test('refuses removal while another tab of this Host is open, also when both try', async ({
  page,
  context,
}) => {
  const status = page.locator('#status');
  const remove = page.getByRole('button', { name: 'Remove retained package', exact: true });
  await page.goto('/');
  await expect(page.getByLabel('Package retention')).toContainText('0.0.2 retained');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByLabel('Package retention')).toHaveText(
    'Packages: 0.0.1 restored, 0.0.2 restored',
  );
  // The other tab has 0.0.2 open; this tab cannot see that, so it does not remove.
  await other.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await remove.click();
  await expect(status).toHaveText(
    'example.counter@0.0.2 is still needed by: another open tab of this Host',
  );
  // Both tabs try at once: neither sees the other as gone.
  await Promise.all([
    remove.click(),
    other.getByRole('button', { name: 'Remove retained package', exact: true }).click(),
  ]);
  await expect(status).toHaveText(
    'example.counter@0.0.2 is still needed by: another open tab of this Host',
  );
  await expect(other.locator('#status')).toHaveText(
    'example.counter@0.0.2 is still needed by: open Editor 0.0.2, another open tab of this Host',
  );
  // A staged leftover (no install runs outside the change lock) is discarded by a starting tab.
  await editStore(page, 'stage-leftover');
  await other.close();
  await remove.click();
  await expect(status).toHaveText('Removed package 0.0.2; saved drafts and versions unchanged');
  await page.reload();
  await expect(page.getByLabel('Package retention')).toHaveText(
    'Packages: discarded 1 interrupted install, 0.0.1 restored, 0.0.2 removed',
  );
});

test('retries retention of a package that is loaded but was not stored', async ({ page }) => {
  // Quota failure while staging, as storage pressure would cause, until the test lifts it.
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if ((window as { quota?: boolean }).quota !== false)
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return add.apply(this, args);
    };
  });
  const retention = page.getByLabel('Package retention');
  await page.goto('/');
  await expect(retention).toHaveText(
    'Packages: 0.0.1 not retained (storage), 0.0.2 not retained (storage)',
  );
  await page.evaluate(() => ((window as { quota?: boolean }).quota = false));
  await page.getByRole('button', { name: 'Retain package', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Retained package 0.0.2');
  await expect(retention).toHaveText('Packages: 0.0.1 not retained, 0.0.2 kept');
  await page.getByRole('button', { name: 'Retain package', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Package 0.0.2 is already retained');
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(page.getByLabel('Installed fixture')).toContainText('Fixture 0.0.2');
});
