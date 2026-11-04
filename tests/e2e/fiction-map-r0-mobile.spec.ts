import { mount, native, revision, outsideReleaseThenNudge } from './fiction-map-r0-fixtures';
import { test, expect } from './fixtures';

test('R2 review: outside pointerup after cancellation permits keyboard nudge and Undo/Redo at 390px', async ({
  page,
}, info) => {
  await outsideReleaseThenNudge(page, info.outputPath('outside-release-nudge.png'));
});

test('R0 narrow viewport: public CanvasStage fixture, read-only and native stability', async ({
  page,
}) => {
  await mount(page);
  await page.getByTestId('label-city').tap();
  await expect(page.getByTestId('selection')).toHaveText('city');
  const native = await page.getByTestId('native').textContent();
  const rev = await page.getByTestId('revision').textContent();
  await page.getByLabel('Read only').check();
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('native')).toHaveText(native!);
  await expect(page.getByTestId('revision')).toHaveText(rev!);
  await expect(page.getByRole('application', { name: 'R0 map probe' })).toBeInViewport();
});

test('R0 narrow viewport: locked vertex and composing key guards preserve native history', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Toggle locked concave' }).tap();
  await page.getByRole('button', { name: 'Select concave' }).tap();
  await page.getByRole('button', { name: 'Toggle vertex mode' }).tap();
  const base = await native(page),
    rev = await revision(page);
  const vertex = page.getByRole('button', { name: 'Vertex 0', exact: true });
  await expect(vertex).toHaveAttribute('aria-disabled', 'true');
  const b = (await vertex.boundingBox())!;
  // Send a real touch to a disabled target; locator.tap waits for enabled state.
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await page
    .getByRole('application', { name: 'R0 map probe' })
    .dispatchEvent('keydown', { key: 'ArrowRight', isComposing: true });
  await expect(page.getByTestId('vertex-preview')).toHaveText('');
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
});
