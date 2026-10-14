import { test, expect, create, nativeArtifact } from './fixtures';
import { jsonApply } from './design-react-fixtures';
import { value } from './practical-fixtures';
import type { DesignContent } from '@editor-platform/design/model';
test('#29 mobile ordinary Design Library/Inspector keeps native identity and runs original React', async ({
  page,
}, info) => {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await value(page, 'React prop label', 'Mobile action');
  const artifact = await nativeArtifact(page),
    d = artifact.draft.content as DesignContent;
  expect(artifact.kind).toBe('design');
  await jsonApply(page, 'React page settings', {
    ...d.web!,
    callbacks: { onBuy: { parameters: [], returns: 'void' } },
  });
  await jsonApply(page, 'React bindings', { onPress: { kind: 'callback', callback: 'onBuy' } });
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  await dialog.getByRole('button', { name: 'Interact with React', exact: true }).click();
  const frame = dialog.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: 'Mobile action', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Mobile action', exact: true }).click();
  await expect(dialog.locator('.design-react-preview')).toHaveAttribute(
    'data-preview-status',
    /Callback onPress/,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('ordinary-design-mobile-react.png') });
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await page.screenshot({ path: info.outputPath('ordinary-design-mobile-source-canvas.png') });
  await page.reload();
  expect(
    ((await nativeArtifact(page)).draft.content as DesignContent).elements[0].react?.props.label,
  ).toBe('Mobile action');
});
