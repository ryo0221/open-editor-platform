import { test, expect } from '@playwright/test';
test('base transforms accept negative values typed one character at a time', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  for (const property of ['x', 'y', 'scaleX', 'scaleY', 'rotation']) {
    const input = page.getByLabel(`Base ${property}`, { exact: true });
    await input.fill('');
    await input.pressSequentially('-', { delay: 100 });
    await input.pressSequentially('12', { delay: 100 });
    await expect(input).toHaveValue('-12');
  }
  await page.getByRole('button', { name: 'Apply base transform', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Base transform applied');
  for (const property of ['x', 'y', 'scaleX', 'scaleY', 'rotation']) {
    await expect(page.getByLabel(`Base ${property}`, { exact: true })).toHaveValue('-12');
  }
  const x = page.getByLabel('Base x', { exact: true });
  await x.fill('');
  await x.pressSequentially('-0.', { delay: 100 });
  await x.pressSequentially('5', { delay: 100 });
  await expect(x).toHaveValue('-0.5');
  await page.getByRole('button', { name: 'Apply base transform', exact: true }).click();
  await expect(x).toHaveValue('-0.5');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(x).toHaveValue('-12');
  expect(errors).toEqual([]);
});
