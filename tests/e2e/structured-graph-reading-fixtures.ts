import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mountReadingGraphHost } from './structured-graph-fixtures';

export async function expectGraphFitted(page: Page) {
  await expect
    .poll(() =>
      page.locator('.ep-graph-node').evaluateAll((nodes) => {
        const canvas = document
          .querySelector('[aria-label="Graph canvas"]')!
          .getBoundingClientRect();
        return nodes.every((node) => {
          const box = node.getBoundingClientRect();
          return (
            box.left >= canvas.left - 1 &&
            box.right <= canvas.right + 1 &&
            box.top >= canvas.top - 1 &&
            box.bottom <= canvas.bottom + 1
          );
        });
      }),
    )
    .toBe(true);
}
export async function readingSnapshot(page: Page) {
  const source = (await page.getByTestId('reading-source').textContent())!;
  return {
    source,
    hash: createHash('sha256').update(source).digest('hex'),
    revision: await page.getByTestId('reading-revision').textContent(),
  };
}
export async function checkReadingControls(page: Page) {
  await mountReadingGraphHost(page);
  await expectGraphFitted(page);
  const original = await readingSnapshot(page);
  const fittedZoom = Number.parseFloat(
    (await page.getByLabel('Graph zoom', { exact: true }).textContent())!,
  );
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  expect(
    Number.parseFloat((await page.getByLabel('Graph zoom', { exact: true }).textContent())!),
  ).toBeLessThan(fittedZoom);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expectGraphFitted(page);
  const node = page.locator('[data-node-id="n0"] .ep-graph-node-select');
  const fullLabel =
    '段階の表のどのマスも、ストーリーとつながってから進むための長いノードラベル全文';
  await expect(node).toHaveAttribute('title', fullLabel);
  await expect(node).toHaveAccessibleName(`Select node ${fullLabel}`);
  await node.click();
  await expect(page.getByTestId('reading-selection')).toHaveText('n0');
  await expect(page.locator('.ep-graph-attribute-values')).toContainText(fullLabel);
  for (const name of [
    'Add node',
    'Delete selection',
    'Graph properties',
    'Apply attributes',
    'Cancel attributes',
    'Add connection',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(
    page.locator('.ep-graph-drag, .ep-graph-connection, .ep-graph-inspector input'),
  ).toHaveCount(0);
  await node.focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-node-id="n12"]')).toHaveClass(/dimmed/);
  await expect(page.locator('[data-node-id="n1"]')).not.toHaveClass(/dimmed/);
  await expect(page.locator('[data-edge-id="e2-1-0"]')).toHaveClass(/dimmed/);
  await page.getByLabel('Show Inspector', { exact: true }).uncheck();
  await expect(page.getByLabel('Graph Inspector', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expectGraphFitted(page);
  await page.locator('[data-node-id="n1"] button').click();
  await expect(page.getByTestId('reading-selection')).toHaveText('n1');
  await page.getByLabel('Show Inspector', { exact: true }).check();
  await expect(page.locator('.ep-graph-attribute-values')).toContainText('Item 1');
  await page.getByLabel('Profile read only', { exact: true }).check();
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toHaveCount(0);
  await page.getByLabel('Profile read only', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Connection editor', { exact: true })).toBeVisible();
  await page.getByLabel('Host read only', { exact: true }).check();
  expect(await readingSnapshot(page)).toEqual(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => innerWidth)).toBe(page.viewportSize()!.width);
}
export async function checkReadingFilters(page: Page) {
  await mountReadingGraphHost(page);
  await expectGraphFitted(page);
  const original = await readingSnapshot(page);
  await page.locator('[data-node-id="n0"] button').click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const manualZoom = await page.getByLabel('Graph zoom', { exact: true }).textContent();
  await page.getByRole('button', { name: 'Host rerender', exact: true }).click();
  await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(manualZoom!);
  await page.getByLabel('Node filter', { exact: true }).selectOption('pair');
  await expectGraphFitted(page);
  await expect(page.locator('.ep-graph-node')).toHaveCount(2);
  const zoom = await page.getByLabel('Graph zoom', { exact: true }).textContent();
  await page.getByLabel('Refit filters', { exact: true }).uncheck();
  await page.getByLabel('Node filter', { exact: true }).selectOption('all');
  await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText(zoom!);
  await page.getByLabel('Refit filters', { exact: true }).check();
  await page.getByLabel('Node filter', { exact: true }).selectOption('none');
  await expect(page.locator('.ep-graph-node')).toHaveCount(0);
  await expect(page.getByTestId('reading-selection')).toHaveText('n0');
  await page.getByLabel('Node filter', { exact: true }).selectOption('all');
  await expectGraphFitted(page);
  const diagnostics = await page.getByLabel('Graph diagnostics', { exact: true }).textContent();
  await page.getByLabel('Edge filter', { exact: true }).selectOption('relation0');
  const graph = JSON.parse(original.source);
  await expect(page.locator('[data-edge-id]')).toHaveCount(
    graph.edges.filter((edge: { type: string }) => edge.type === 'relation0').length,
  );
  await page.getByLabel('Edge filter', { exact: true }).selectOption('none');
  await expect(page.locator('[data-edge-id]')).toHaveCount(0);
  await expect(page.getByLabel('Graph diagnostics', { exact: true })).toHaveText(diagnostics!);
  await page.getByLabel('Graph diagnostics', { exact: true }).getByRole('button').first().click();
  await expect(page.getByTestId('reading-selection')).toHaveText('n11');
  await page.getByLabel('Highlight neighbors', { exact: true }).uncheck();
  await expect(page.locator('.dimmed')).toHaveCount(0);
  expect(await readingSnapshot(page)).toEqual(original);
}

/** Review regressions use browser geometry and synthetic composition, not physical IME coverage. */
export async function checkGraphSwitchCamera(page: Page, view: 'origin' | 'custom') {
  await mountReadingGraphHost(page, `?view=${view}&switch-camera`);
  const canvas = page.getByLabel('Graph canvas', { exact: true });
  const initialTransform = await page.locator('.ep-graph-plane').getAttribute('style');
  expect(JSON.parse((await readingSnapshot(page)).source).profile).toEqual({
    id: 'reading-fixture',
    version: 1,
  });
  await canvas.evaluate((el) => {
    el.scrollLeft = 420;
    el.scrollTop = 380;
    el.setAttribute('data-same-canvas', 'yes');
  });
  const offsets = await canvas.evaluate((el) => [el.scrollLeft, el.scrollTop]);
  expect(offsets.every((n) => n > 100)).toBe(true);
  await page.getByRole('button', { name: 'Switch graph', exact: true }).click();
  await expect
    .poll(async () => JSON.parse((await readingSnapshot(page)).source).id)
    .toBe('reading-graph-b');
  await expect(canvas).toHaveAttribute('data-same-canvas', 'yes');
  await expect.poll(() => canvas.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
  await expect(page.locator('.ep-graph-plane')).toHaveAttribute('style', initialTransform!);
  const original = await readingSnapshot(page);
  await canvas.evaluate((el) => {
    el.scrollLeft = 230;
    el.scrollTop = 180;
  });
  const manual = await canvas.evaluate((el) => [el.scrollLeft, el.scrollTop]);
  await page.getByRole('button', { name: 'Host rerender', exact: true }).click();
  expect(await canvas.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual(manual);
  expect(await readingSnapshot(page)).toEqual(original);
}
export async function checkCompositionReadonly(
  page: Page,
  permission: 'Host read only' | 'Profile read only',
) {
  await mountReadingGraphHost(page, '?inputs');
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await page.locator('[data-node-id="n0"] .ep-graph-node-select').click();
  const original = await readingSnapshot(page);
  const input = page.getByLabel('name', { exact: true });
  await input.focus();
  await input.dispatchEvent('compositionstart', { data: '' });
  await input.fill('未確定の属性を保持');
  // Programmatic permission change must not rely on a browser blur/compositionend.
  await page
    .getByLabel(permission, { exact: true })
    .evaluate((el) => (el as HTMLInputElement).click());
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Save boundary', exact: true }).click();
  await expect(page.getByTestId('flush-result')).not.toHaveText('saved');
  await expect(page.getByTestId('input-state')).toContainText('"dirty":1');
  await page.locator('[data-node-id="n1"] .ep-graph-node-select').click();
  await expect(page.getByTestId('reading-selection')).toHaveText('n1');
  await page.getByLabel(permission, { exact: true }).uncheck();
  await page.locator('[data-node-id="n0"] .ep-graph-node-select').click();
  await expect(input).toHaveValue('未確定の属性を保持');
  expect(await readingSnapshot(page)).toEqual(original);
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  expect(JSON.parse((await readingSnapshot(page)).source).nodes[0].attributes.name).toBe(
    '未確定の属性を保持',
  );
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await readingSnapshot(page)).source).toBe(original.source);
}
export async function checkActualLabelBounds(page: Page) {
  await mountReadingGraphHost(page, '?wide-label');
  const original = await readingSnapshot(page);
  for (const font of ['system-ui', 'monospace', 'serif']) {
    await page.addStyleTag({ content: `.ep-graph-edge-label text { font-family: ${font}; }` });
    await page.getByRole('button', { name: 'Host rerender', exact: true }).click();
    await page.mouse.move(0, 0);
    // Glyph bounds, including overhang/height, must fit the measured background.
    const geometry = await page.locator('.ep-graph-edge-label text').evaluate((el) => {
      const b = (el as SVGGraphicsElement).getBBox();
      const text = el.getBoundingClientRect(),
        rect = el.previousElementSibling!.getBoundingClientRect();
      const style = getComputedStyle(el.parentElement!);
      const shown = style.display !== 'none' && style.visibility !== 'hidden';
      const overlaps = [...document.querySelectorAll('.ep-graph-node')].some((n) => {
        const b = n.getBoundingClientRect();
        return (
          text.left < b.right && text.right > b.left && text.top < b.bottom && text.bottom > b.top
        );
      });
      return {
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        font: getComputedStyle(el).font,
        shown,
        overlaps,
        contained:
          text.left >= rect.left &&
          text.right <= rect.right &&
          text.top >= rect.top &&
          text.bottom <= rect.bottom,
      };
    });
    expect(geometry.font).toContain('12px');
    expect(geometry.shown && geometry.overlaps, JSON.stringify(geometry)).toBe(false);
    expect(geometry.contained, JSON.stringify(geometry)).toBe(true);
    const hit = page.locator('[data-edge-id="wide"] .ep-graph-edge-hit');
    await expect(hit).toHaveAccessibleName(new RegExp('W'.repeat(60)));
    await hit.focus();
    await expect(page.locator('.ep-graph-edge-label text')).toBeVisible();
    await expect(page.locator('.ep-graph-edge-label text')).toHaveText('W'.repeat(60));
    expect(await readingSnapshot(page)).toEqual(original);
  }
}

export async function checkMeasuredInitialFit(page: Page, mode: 'fresh' | 'switch' | 'filter') {
  await mountReadingGraphHost(
    page,
    `?loop-fit${mode !== 'switch' ? '&fresh' : ''}${mode === 'filter' ? '&hidden' : ''}`,
  );
  if (mode === 'filter') await page.getByLabel('Node filter', { exact: true }).selectOption('all');
  if (mode === 'switch') {
    await expectGraphFitted(page);
    await page.getByRole('button', { name: 'Switch graph', exact: true }).click();
  }
  const label = page.locator('.ep-graph-edge-label text');
  await expect(label).toBeVisible();
  const bounds = () =>
    label.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const canvas = document.querySelector('[aria-label="Graph canvas"]')!.getBoundingClientRect();
      return {
        fits:
          box.left >= canvas.left &&
          box.right <= canvas.right &&
          box.top >= canvas.top &&
          box.bottom <= canvas.bottom,
        left: box.left,
        right: box.right,
        top: box.top,
        canvasLeft: canvas.left,
        canvasRight: canvas.right,
        canvasTop: canvas.top,
      };
    });
  const before = await bounds();
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expect.poll(async () => (await bounds()).fits).toBe(true);
  expect(before, 'initial Fit must include measured glyph bounds as manual Fit does').toMatchObject(
    { fits: true },
  );
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const camera = await page.locator('.ep-graph-plane').getAttribute('style');
  await page.addStyleTag({ content: '.ep-graph-edge-label text { font-family: monospace; }' });
  await page.getByRole('button', { name: 'Host rerender', exact: true }).click();
  await expect(page.locator('.ep-graph-plane')).toHaveAttribute('style', camera!);
}

export async function checkNoopCompositionSave(page: Page) {
  await mountReadingGraphHost(page, '?inputs');
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await page.locator('[data-node-id="n0"] .ep-graph-node-select').click();
  const original = await readingSnapshot(page);
  await page.getByLabel('name', { exact: true }).dispatchEvent('compositionstart', { data: '' });
  await expect(page.getByTestId('input-state')).toContainText('"composing":1');
  await page
    .getByLabel('Host read only', { exact: true })
    .evaluate((el) => (el as HTMLInputElement).click());
  await page.getByRole('button', { name: 'Save boundary', exact: true }).click();
  expect(await readingSnapshot(page)).toEqual(original);
  await expect(page.getByTestId('flush-result')).toHaveText('saved');
  await expect(page.getByTestId('input-state')).toContainText('"dirty":0');
}

export async function checkUnmeasurableFit(
  page: Page,
  mode: 'refused' | 'empty' | 'space' | 'zero',
) {
  await mountReadingGraphHost(page, `?fit-unmeasurable=${mode}`);
  const original = await readingSnapshot(page);
  if (mode === 'refused') {
    await expect(page.locator('[data-edge-id="probe"] .ep-graph-edge-label text')).toHaveCount(0);
    await expect(page.locator('[data-edge-id="probe"]')).toContainText(
      'ノードの重なりを解消してください',
    );
  } else
    await expect(page.locator('[data-edge-id="probe"] .ep-graph-edge-label text')).toHaveCount(1);
  await expectGraphFitted(page);
  await page.getByLabel('Node filter', { exact: true }).selectOption('pair');
  await expectGraphFitted(page);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByLabel('Node filter', { exact: true }).selectOption('all');
  await expectGraphFitted(page);
  expect(await readingSnapshot(page)).toEqual(original);
  if (mode === 'refused')
    await expect(page.locator('[data-edge-id="probe"]')).toContainText(
      'ノードの重なりを解消してください',
    );
}
