import { test, expect, create } from './fixtures';
test('W3 mobile Library, Inspector and real controlled form', async ({ page }, info) => {
  await page.goto('/');
  await create(page, 'react-ui');
  await page.getByRole('button', { name: 'Load example Contact form', exact: true }).click();
  await page.getByRole('button', { name: 'buy · Button', exact: true }).click();
  await page.getByLabel('Prop label', { exact: true }).fill('Contact team');
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(page.locator('iframe[title="React component preview"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await frame.getByRole('textbox', { name: 'Name', exact: true }).fill('Mobile');
  await frame.getByRole('button', { name: 'Contact team', exact: true }).click();
  await expect(frame.getByText('Thanks Mobile', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('react-ui-form-mobile.png'), fullPage: true });
});
