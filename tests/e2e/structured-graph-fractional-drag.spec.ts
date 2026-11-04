import { test, expect } from './fixtures';
import { mountFractionalDragGraphHost } from './structured-graph-fixtures';

// Real SVG measurement at a fractional drop reproduced the layout loop at 960/1000px.
// Keep the 720px control and check the native transaction/Undo, not only the absence of a crash.
for (const width of [720, 960, 1000])
  test(`fractional node drag keeps labels and selection usable (${width}px Host)`, async ({
    page,
  }, info) => {
    await mountFractionalDragGraphHost(page, `?width=${width}`);
    const before = JSON.parse((await page.getByTestId('source').textContent())!);
    const handle = await page
      .getByRole('button', { name: 'Move node Item 5', exact: true })
      .boundingBox();
    const target = await page.locator('[data-section-id="g3"]').boundingBox();
    expect(handle && target).toBeTruthy();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      target!.x + target!.width / 2 + 0.125,
      target!.y + target!.height / 2 + 0.375,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: 'Select node Item 5', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('edits')).toHaveText('1');
    const after = JSON.parse((await page.getByTestId('source').textContent())!);
    expect(after.nodes.find((n: { id: string }) => n.id === 'n5').sectionId).toBe('g3');
    expect(
      Number.isInteger(after.presentation.nodes.n5.x) &&
        Number.isInteger(after.presentation.nodes.n5.y),
    ).toBe(false);
    await page.getByRole('button', { name: 'Select node Item 5', exact: true }).click();
    await expect(page.getByLabel('Node section', { exact: true })).toHaveValue('g3');
    await page.screenshot({ path: info.outputPath('fractional-node-drag.png') });
    await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
    expect(JSON.parse((await page.getByTestId('source').textContent())!)).toEqual(before);
  });
