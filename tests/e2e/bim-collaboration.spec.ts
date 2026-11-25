import { create, expect, test } from './fixtures';

test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

test('two Building editors share level changes and the author can undo them', async ({
  page: a, browser, baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const context = await browser.newContext({ baseURL });
  try {
    await a.goto('/');
    await create(a, 'bim');
    const menu = a.getByRole('button', { name: 'More artifact actions', exact: true });
    await menu.click();
    await a.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await menu.click();
    const link = await a.getByRole('link', { name: 'Open peer editor', exact: true }).getAttribute('href');
    expect(link).toBeTruthy();
    await a.keyboard.press('Escape');
    const b = await context.newPage();
    const errors: string[] = [];
    b.on('pageerror', (error) => errors.push(error.message));
    await b.goto(link!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    const inspector = a.locator('.bim-inspector');
    if (!(await inspector.isVisible()))
      await a.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
    const field = inspector.getByLabel('Level name', { exact: true });
    await field.fill('Ground floor');
    await field.press('Enter');
    await expect(b.getByRole('combobox', { name: 'Level', exact: true })).toContainText('Ground floor');
    await a.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(b.getByRole('combobox', { name: 'Level', exact: true })).toContainText('1F');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
