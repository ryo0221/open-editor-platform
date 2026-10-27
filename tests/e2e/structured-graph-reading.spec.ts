import {
  checkDefaultLabels,
  checkDefaultLabelUpdates,
  checkDefaultOverlap,
} from './structured-graph-default-labels';
import {
  checkUnmeasurableFit,
  checkNoopCompositionSave,
  checkMeasuredInitialFit,
  checkGraphSwitchCamera,
  checkCompositionReadonly,
  checkActualLabelBounds,
} from './structured-graph-reading-fixtures';
import { test, expect } from './fixtures';
import { mountReadingGraphHost } from './structured-graph-fixtures';
import {
  checkReadingControls,
  checkReadingFilters,
  expectGraphFitted,
  readingSnapshot,
} from './structured-graph-reading-fixtures';

test('reading Host: readonly tools, full labels, custom Inspector and adjacent emphasis', async ({
  page,
}, info) => {
  await checkReadingControls(page);
  await page.screenshot({ path: info.outputPath('graph-reading-desktop.png') });
});
test('reading Host: initial Fit, optional refit, full-graph diagnostics and private filters', async ({
  page,
}, info) => {
  await checkReadingFilters(page);
  await page.screenshot({ path: info.outputPath('graph-filter-desktop.png') });
});
for (const [view, zoom, transform] of [
  ['origin', '100%', 'translate(0px, 0px) scale(1)'],
  ['legacy', '100%', 'translate(0px, 0px) scale(1)'],
  ['custom', '75%', 'translate(30px, 45px) scale(0.75)'],
])
  test(`reading Host: ${view} initial camera is private and used once`, async ({ page }) => {
    await mountReadingGraphHost(page, `?view=${view}`);
    const original = await readingSnapshot(page);
    await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(zoom);
    await expect(page.locator('.ep-graph-plane')).toHaveAttribute(
      'style',
      new RegExp(transform.replace(/[()]/g, '\\$&')),
    );
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Host rerender', exact: true }).click();
    await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(
      view !== 'custom' ? '125%' : '100%',
    );
    expect(await readingSnapshot(page)).toEqual(original);
  });
test('reading Host: dense labels avoid nodes and each other; styles and deferred labels remain accessible', async ({
  page,
}, info) => {
  await mountReadingGraphHost(page);
  await expectGraphFitted(page);
  const collisions = await page
    .locator('.ep-graph-edge-label:not(.deferred) rect')
    .evaluateAll((labels) => {
      const rects = labels.map((label) => label.getBoundingClientRect());
      const nodes = [...document.querySelectorAll('.ep-graph-node')].map((node) =>
        node.getBoundingClientRect(),
      );
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return rects.some((a, i) => [...nodes, ...rects.slice(i + 1)].some((b) => overlap(a, b)));
    });
  expect(collisions).toBe(false);
  const glyphCollisions = await page
    .locator('.ep-graph-edge-label:not(.deferred) text')
    .evaluateAll((texts) => {
      const glyphs = texts.map((t) => t.getBoundingClientRect());
      const nodes = [...document.querySelectorAll('.ep-graph-node')].map((n) =>
        n.getBoundingClientRect(),
      );
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return glyphs.some((a, i) => [...nodes, ...glyphs.slice(i + 1)].some((b) => overlap(a, b)));
    });
  expect(glyphCollisions).toBe(false);
  await expect(page.locator('[data-edge-id="e0-1-0"] > path').first()).toHaveAttribute(
    'stroke',
    '#1d4ed8',
  );
  await expect(page.locator('[data-edge-id="e0-1-0"] > path').first()).toHaveAttribute(
    'stroke-dasharray',
    '6 4',
  );
  const candidate = page
    .locator('[data-edge-id]')
    .filter({ has: page.locator('.ep-graph-edge-label.deferred') })
    .first();
  const group = page.locator(`[data-edge-id="${await candidate.getAttribute('data-edge-id')}"]`);
  const label = group.locator('.ep-graph-edge-label');
  await page.mouse.move(0, 0);
  await expect(label).toBeHidden();
  await group.locator('.ep-graph-edge-hit').focus();
  await expect(label).toBeVisible();
  await expect(group.locator('title')).toContainText('Relation');
  await page.keyboard.press('Enter');
  await expect(group).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).focus();
  await expect(label).toBeVisible();
  await page.screenshot({ path: info.outputPath('graph-dense-labels-desktop.png') });
});
test('reading Host: custom node dimensions align with ports and switch back to automatic height without edits', async ({
  page,
}) => {
  await mountReadingGraphHost(page);
  const original = await readingSnapshot(page);
  await expect(page.locator('[data-node-id="n0"]')).toHaveCSS('width', '320px');
  await expect(page.locator('[data-node-id="n0"]')).toHaveCSS('height', '140px');
  // Parallel connections spread their ports along the node side, 6px clear of its corners.
  const port = async () => {
    const d = await page.locator('[data-edge-id="e0-1-0"] > path').first().getAttribute('d');
    const [, x, y] = /^M([\d.]+),([\d.]+) /.exec(d ?? '') ?? [];
    return { x: Number(x), y: Number(y) };
  };
  await expect
    .poll(async () => {
      const { x, y } = await port();
      return x === 220 && y >= 56 && y <= 184;
    })
    .toBe(true);
  await page.getByLabel('Custom node sizes', { exact: true }).uncheck();
  await expect(page.locator('[data-node-id="n0"]')).toHaveCSS('width', '200px');
  await expect
    .poll(async () => {
      const height = await page
        .locator('[data-node-id="n0"]')
        .evaluate((el) => parseFloat((el as HTMLElement).style.height));
      const { x, y } = await port();
      return height >= 70 && x === 100 && y >= 56 && y <= 50 + height - 6;
    })
    .toBe(true);
  expect(await readingSnapshot(page)).toEqual(original);
});
test('reading Host: ordinary content edits and Undo preserve the manual camera', async ({
  page,
}) => {
  await mountReadingGraphHost(page);
  await expectGraphFitted(page);
  const original = await readingSnapshot(page);
  await page.locator('[data-node-id="n0"] button').click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoom = await page.getByLabel('Graph zoom', { exact: true }).textContent();
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await page.getByLabel('name', { exact: true }).fill('Edited label');
  await page.getByLabel('Show Inspector', { exact: true }).uncheck();
  await expect(page.getByLabel('Graph Inspector', { exact: true })).toBeHidden();
  await page.getByLabel('Show Inspector', { exact: true }).check();
  await expect(page.getByLabel('name', { exact: true })).toHaveValue('Edited label');
  await page.getByLabel('Host read only', { exact: true }).check();
  expect(await readingSnapshot(page)).toEqual(original);
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await expect(page.getByLabel('name', { exact: true })).toHaveValue('Edited label');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  expect(JSON.parse((await readingSnapshot(page)).source).nodes[0].attributes.name).toBe(
    'Edited label',
  );
  await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(zoom!);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await readingSnapshot(page)).source).toEqual(original.source);
  await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(zoom!);
});
test('reading Host: definition buffers survive Inspector visibility and readonly transitions', async ({
  page,
}) => {
  await mountReadingGraphHost(page);
  const original = await readingSnapshot(page);
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Graph source and definitions', exact: true }).click();
  await page.getByRole('button', { name: 'データ定義', exact: true }).click();
  const label = page.getByLabel('Definition type label', { exact: true });
  await label.fill('Buffered definition label');
  await page.getByLabel('Show Inspector', { exact: true }).uncheck();
  await expect(label).toBeHidden();
  await page.getByLabel('Show Inspector', { exact: true }).check();
  await expect(label).toHaveValue('Buffered definition label');
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(label).toBeHidden();
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await expect(label).toHaveValue('Buffered definition label');
  expect(await readingSnapshot(page)).toEqual(original);
});

for (const view of ['origin', 'custom'] as const)
  test(`review regression: ${view} resets scroll on graph switch`, async ({ page }, info) => {
    await checkGraphSwitchCamera(page, view);
    await page.screenshot({ path: info.outputPath(`review-camera-${view}.png`) });
  });
for (const permission of ['Host read only', 'Profile read only'] as const)
  test(`review regression: ${permission} during composition preserves buffer and selection`, async ({
    page,
  }, info) => {
    await checkCompositionReadonly(page, permission);
    await page.screenshot({ path: info.outputPath('review-composition.png') });
  });
test('review regression: actual wide glyph bounds do not overlap nodes', async ({ page }, info) => {
  await checkActualLabelBounds(page);
  await page.screenshot({ path: info.outputPath('review-wide-label.png') });
});

for (const mode of ['fresh', 'switch', 'filter'] as const)
  test(`review measurement Fit: ${mode}`, async ({ page }) => {
    await checkMeasuredInitialFit(page, mode);
  });

test('review no-op composition permits Save after readonly', async ({ page }) => {
  await checkNoopCompositionSave(page);
});

for (const mode of ['refused', 'empty', 'space', 'zero'] as const)
  test(`review Fit readiness: ${mode}`, async ({ page }) => {
    await checkUnmeasurableFit(page, mode);
  });

test('default node labels: full Japanese English unbroken and multiline text', async ({
  page,
}, info) => {
  await checkDefaultLabels(page);
  await page.screenshot({ path: info.outputPath('default-labels.png') });
});
test('default node labels: real font loading editing Undo and explicit override', async ({
  page,
}, info) => {
  await checkDefaultLabelUpdates(page);
  await page.screenshot({ path: info.outputPath('default-label-updates.png') });
});

test('default node labels: derived height drives overlap refusal and explicit sizing', async ({
  page,
}) => {
  await checkDefaultOverlap(page);
});
