import { create, test, expect } from './fixtures';

// Issue #374: the header menus stayed open over what their items opened, and a missing
// shared server surfaced a raw SyntaxError that followed the user to other artifacts.

test('ST-01#8 a picked item closes the More and Export menus so the opened panel is usable', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Code Review', exact: true }).click();
  await page.getByRole('button', { name: 'added new line 2', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'More artifact actions', exact: true });
  await more.getByRole('button', { name: /^Comments \(/ }).click();
  await expect(more).toBeHidden();
  // No Escape first: the comment field and Close comments are not covered by the menu.
  await page.getByLabel('Comment', { exact: true }).fill('メニューに隠れない');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('.comment-thread').first()).toContainText('メニューに隠れない');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close comments', exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const exportMenu = page.getByRole('dialog', { name: 'Export artifact', exact: true });
  const download = page.waitForEvent('download');
  await exportMenu.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await download;
  await expect(exportMenu).toBeHidden();
  // Nothing else took focus, so it returns to the menu's trigger.
  await expect(page.getByRole('button', { name: 'Export artifact', exact: true })).toBeFocused();
});

test('ST-14#6 without a shared server, Open collaboratively says why and the notice stays with its artifact', async ({
  page,
}) => {
  // The dev server without the reference authority answers with an empty body.
  await page.route('**/collaboration-api/editor/session', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'New Code Review', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'Collaboration could not start: the shared server did not respond. Your artifact is unchanged.',
  );
  await expect(alert).not.toContainText('SyntaxError');
  await expect(page).toHaveURL(/^[^?]*$/);
  await expect(page.locator('.save-status')).not.toContainText('Shared');

  await create(page, 'document');
  await expect(page.getByText('Collaboration could not start', { exact: false })).toHaveCount(0);
});
