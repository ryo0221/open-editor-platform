import { expect, test } from '@playwright/test';

for (const change of ['read-only', 'edit', 'uninstall'] as const) {
  test(`pending version save refuses after ${change}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/');
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args) => {
        await new Promise<void>((resolve) => {
          (window as unknown as { finishDigest: () => void }).finishDigest = resolve;
        });
        return digest(...args);
      };
    });
    await page.getByRole('button', { name: 'Save document version', exact: true }).click();
    await page.waitForFunction(() => 'finishDigest' in window);
    if (change === 'read-only') await page.getByLabel('Read-only').check();
    else
      await page
        .getByRole('button', { name: change === 'edit' ? 'Increment' : 'Uninstall', exact: true })
        .click();
    await page.evaluate(() => (window as unknown as { finishDigest: () => void }).finishDigest());
    await expect(page.locator('#status')).toHaveText(
      change === 'read-only'
        ? 'Permission denied'
        : change === 'edit'
          ? 'Draft changed; try again'
          : 'Registration revoked',
    );
    expect(
      await page.evaluate(() => localStorage.getItem('extension.counter.versions')),
    ).toBeNull();
    if (change === 'edit') {
      await expect(page.getByLabel('Counter value')).toHaveText('1');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByLabel('Counter value')).toHaveText('0');
    }
    expect(errors).toEqual([]);
  });
}

test('document restore keeps immutable versions and package pin across reopen', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
  const value = page.getByLabel('Counter value');
  const raw = () => page.evaluate(() => localStorage.getItem('extension.counter.versions'));
  const status = page.locator('#status');
  await click('Increment');
  await click('Save document version');
  await expect(status).toHaveText('Saved document version');
  await click('Increment');
  await click('Save document version');
  await expect(page.getByLabel('Saved version').locator('option')).toHaveCount(2);
  const bytes = (await raw())!;
  const saved = JSON.parse(bytes);
  await click('Install fixture 0.0.2');
  const pin = await page.getByLabel('Installed fixture').textContent();
  await page.getByLabel('Saved version').selectOption(saved.versions[0].versionId);
  await click('Restore as new draft');
  await expect(value).toHaveText('1');
  await expect(status).toContainText('new unsaved draft');
  expect(await raw()).toBe(bytes);
  await expect(page.getByLabel('Installed fixture')).toHaveText(pin!);
  await click('Undo');
  await expect(value).toHaveText('1');
  await click('Increment');
  await click('Increment');
  await click('Save document version');
  await expect(page.getByLabel('Saved version').locator('option')).toHaveCount(3);
  const branch = JSON.parse((await raw())!);
  expect(branch.versions.slice(0, 2)).toEqual(saved.versions);
  expect(branch.versions[2].parentVersionId).toBe(saved.versions[0].versionId);
  await page.reload();
  await click('Load document versions');
  await expect(page.getByLabel('Saved version').locator('option')).toHaveCount(3);
  await expect(value).toHaveText('0');
  await page.getByLabel('Saved version').selectOption(branch.versions[2].versionId);
  await click('Restore as new draft');
  await expect(value).toHaveText('3');
  await page.getByLabel('Read-only').check();
  for (const action of ['Save document version', 'Restore as new draft']) {
    await click(action);
    await expect(status).toHaveText('Permission denied');
    await expect(value).toHaveText('3');
  }
  await page.screenshot({ path: info.outputPath('document-versions.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('corrupt retained versions and storage failure leave the draft and history intact', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
  await click('Increment');
  await click('Save document version');
  await expect(page.locator('#status')).toHaveText('Saved document version');
  await click('Increment');
  await click('Undo');
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('extension.counter.versions')!);
    a.versions[0].content.value = 5;
    localStorage.setItem('extension.counter.versions', JSON.stringify(a));
  });
  const corrupted = await page.evaluate(() => localStorage.getItem('extension.counter.versions'));
  await click('Restore as new draft');
  await expect(page.locator('#status')).toHaveText('Invalid saved document versions');
  await click('Redo');
  await expect(page.getByLabel('Counter value')).toHaveText('2');
  expect(await page.evaluate(() => localStorage.getItem('extension.counter.versions'))).toBe(
    corrupted,
  );
  await page.evaluate(() => {
    localStorage.removeItem('extension.counter.versions');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'extension.counter.versions') throw new Error('Storage full');
      return original.call(this, key, value);
    };
  });
  await click('Save document version');
  await expect(page.locator('#status')).toContainText('unavailable');
  // A fresh page has no restored base; exercise the actual storage write failure.
  await page.reload();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error('Storage full');
    };
  });
  await click('Increment');
  await click('Save document version');
  await expect(page.locator('#status')).toHaveText('Storage full');
  await expect(page.getByLabel('Counter value')).toHaveText('1');
  await click('Undo');
  await expect(page.getByLabel('Counter value')).toHaveText('0');
  expect(await page.evaluate(() => localStorage.getItem('extension.counter.versions'))).toBeNull();
  expect(errors).toEqual([]);
});
