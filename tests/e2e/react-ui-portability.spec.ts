import { test, expect } from './fixtures';
import { portabilityFlow } from './react-ui-portability-flow';
test('ordinary Library/Inspector empty-slot edit, Undo, save/reload and deterministic formatted ZIP', async ({
  page,
}, info) => portabilityFlow(page, info));

test('independent typed Host keeps default slots and normalized enum callback in generated React', async ({
  page,
}, info) => {
  for (const width of [390, 1024, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('http://127.0.0.1:4175/portable/');
    await expect(page.getByRole('heading', { name: 'Portable page', exact: true })).toBeVisible();
    await expect(page.getByText('Default body', { exact: true })).toBeVisible();
    await expect(page.getByText('Absent action', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Default action', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Picked open', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('portable-host-' + width + '.png') });
  }
});
