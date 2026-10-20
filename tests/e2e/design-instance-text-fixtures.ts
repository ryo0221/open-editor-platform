import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { independentDesignReuse } from './design-reuse-graphics-fixtures';
import {
  nestedTextFixture,
  styledHiddenGeometryFixture,
} from '../fixtures/design-nested-text/content';
import { designDrawings, type DesignContent } from '@editor-platform/design/model';

export async function editNestedText(page: Page, info: TestInfo) {
  const before = nestedTextFixture();
  await independentDesignReuse(page, before);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await canvas.getByText('Nested title', { exact: true }).first().dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+a');
  await page.keyboard.insertText('Nested edited');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(canvas.getByText('Nested edited', { exact: true })).toHaveCount(1);
  await expect(canvas.getByText('Nested title', { exact: true })).toHaveCount(1);
  await expect(canvas.getByText('Retained body', { exact: true })).toHaveCount(2);
  const native: DesignContent = JSON.parse((await page.getByTestId('reuse-native').textContent())!);
  expect(native.components).toEqual(before.components);
  expect(native.elements[1]).toEqual(before.elements[1]);
  expect(native.elements[0].overrides?.section.overrides?.title.text).toBe('Nested edited');
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await expect(canvas.getByText('Nested edited', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  await expect(canvas.getByText('Nested edited', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  await expect(canvas.getByText('Nested edited', { exact: true })).toHaveCount(1);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(native);
  await page.getByRole('checkbox', { name: 'Host read only', exact: true }).check();
  await canvas.getByText('Nested edited', { exact: true }).dblclick();
  await expect(editor).toHaveCount(0);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(native);
  await page.screenshot({ path: info.outputPath('nested-text-saved.png') });
  expect(
    designDrawings(native, native.elements[0]).find((d) => d.text === 'Retained body')?.typography
      ?.bold,
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export async function editPrimitiveTextFromInspector(page: Page, info: TestInfo) {
  const before = nestedTextFixture();
  delete before.components[0].elements;
  before.components[0].template.text = 'Primitive title';
  before.components[1].elements![0].overrides = {
    root: {
      fill: '#112233',
      bounds: { x: 3, y: 4, width: 180, height: 90 },
      rotation: 15,
      typography: { fontSize: 18, bold: true },
    },
  };
  before.elements[0].overrides = {
    section: {
      bounds: { x: 20, y: 20, width: 240, height: 160 },
      rotation: 0,
      typography: { fontSize: 24 },
    },
  };
  const originalDrawing = designDrawings(before, before.elements[0])[0];
  await independentDesignReuse(page, before);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await canvas.getByText('Primitive title', { exact: true }).first().dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+a');
  await page.keyboard.insertText('Canvas title');
  await editor.press('Control+Enter');
  const text = page.getByRole('textbox', { name: 'Component text section', exact: true });
  if (!(await text.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await expect(text).toHaveValue('Canvas title');
  const fill = page.getByRole('textbox', { name: 'Component fill section', exact: true });
  await expect(fill).toHaveValue('#112233');
  await text.fill('Inspector title');
  await text.press('Enter');
  await expect(text).toHaveValue('Inspector title');
  await fill.fill('#abcdef');
  await fill.press('Enter');
  await expect(fill).toHaveValue('#abcdef');
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await expect(canvas.getByText('Inspector title', { exact: true })).toHaveCount(1);
  await expect(canvas.getByText('Primitive title', { exact: true })).toHaveCount(1);
  const after = JSON.parse((await page.getByTestId('reuse-native').textContent())!);
  expect(after.components).toEqual(before.components);
  expect(after.elements[1]).toEqual(before.elements[1]);
  expect(designDrawings(after, after.elements[0])[0]).toMatchObject({
    text: 'Inspector title',
    fill: '#abcdef',
    bounds: originalDrawing.bounds,
    rotation: originalDrawing.rotation,
    typography: originalDrawing.typography,
  });
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await expect(canvas.getByText('Canvas title', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  await expect(canvas.getByText('Inspector title', { exact: true })).toHaveCount(1);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(after);
  await canvas.getByText('Inspector title', { exact: true }).click();
  if (!(await text.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await expect(text).toHaveValue('Inspector title');
  await expect(fill).toHaveValue('#abcdef');
  await page.screenshot({ path: info.outputPath('primitive-canvas-inspector-saved.png') });
}

export async function assertPrimitiveLocks(page: Page, info: TestInfo) {
  const before = nestedTextFixture();
  delete before.components[0].elements;
  before.components[0].template.text = 'Primitive title';
  before.styles = [{ id: 'lock', name: 'Locked text', appearance: { locked: true } }];
  before.elements = [
    {
      ...before.elements[0],
      componentId: 'inner',
      styleId: 'lock',
      overrides: { root: { text: 'Style locked' } },
    },
    {
      ...before.elements[1],
      componentId: 'inner',
      overrides: { root: { text: 'Root locked', locked: true } },
    },
    {
      ...before.elements[1],
      id: 'editable',
      componentId: 'inner',
      bounds: { x: 730, y: 30, width: 300, height: 220 },
      overrides: { root: { text: 'Editable title' } },
    },
  ];
  await independentDesignReuse(page, before);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  for (const text of ['Style locked', 'Root locked']) {
    await canvas.getByText(text, { exact: true }).dblclick();
    await expect(editor).toHaveCount(0);
  }
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(before);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('primitive-effective-locks.png') });
  await canvas.getByText('Editable title', { exact: true }).dblclick();
  await expect(editor).toBeVisible();
  await editor.press('Escape');
}

export async function assertCompositeStyleLocks(page: Page, info: TestInfo) {
  const before = nestedTextFixture();
  before.styles = [
    { id: 'lock', name: 'Locked composite', appearance: { locked: true } },
    { id: 'hide', name: 'Hidden composite', appearance: { hidden: true } },
  ];
  before.elements = [
    { ...before.elements[0], styleId: 'lock' },
    { ...before.elements[1], styleId: 'hide' },
    { ...before.elements[1], id: 'editable', bounds: { x: 730, y: 30, width: 300, height: 220 } },
  ];
  await independentDesignReuse(page, before);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  const labels = canvas.getByText('Nested title', { exact: true });
  await expect(labels).toHaveCount(2);
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await labels.first().dblclick();
  await expect(editor).toHaveCount(0);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(before);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('composite-effective-style-locks.png') });
  await labels.last().dblclick();
  await expect(editor).toBeVisible();
  await editor.press('Escape');
}

export async function assertStyledHiddenGeometry(page: Page, info: TestInfo) {
  const before = styledHiddenGeometryFixture();
  await independentDesignReuse(page, before);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  const visible = canvas.getByRole('button', { name: 'Design object card', exact: true });
  await expect(canvas.locator('[data-canvas-target]')).toHaveCount(1);
  await expect(visible).toBeVisible();
  const zoom = page.getByRole('combobox', { name: 'Canvas zoom', exact: true });
  const viewport = await canvas.boundingBox();
  const expectedZoom = (padding: number) =>
    Math.min(8, (viewport!.width - padding) / 300, (viewport!.height - padding) / 220);
  expect(Number(await zoom.inputValue())).toBeCloseTo(expectedZoom(48), 8);
  for (const label of ['Fit design', 'Fit selection']) {
    await visible.click();
    await canvas.press('Control+a');
    await expect(visible).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: label, exact: true }).click();
    expect(Number(await zoom.inputValue())).toBeCloseTo(expectedZoom(60), 8);
  }
  await canvas.press('ArrowRight');
  const moved = JSON.parse((await page.getByTestId('reuse-native').textContent())!);
  expect(moved.elements[0].bounds.x).toBe(before.elements[0].bounds.x + 1);
  expect(moved.elements.slice(1)).toEqual(before.elements.slice(1));
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(before);
  for (const format of ['SVG', 'PNG']) {
    if (!(await page.getByRole('button', { name: 'Export design', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await page.getByRole('button', { name: 'Export design', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export all ${format}`, exact: true }).click();
    const bytes = await readFile((await (await pending).path())!);
    if (format === 'SVG') {
      expect(bytes.toString()).toContain('viewBox="10 10 340 260"');
      expect(bytes.toString()).not.toContain('Hidden primitive');
    } else {
      const size = await page.evaluate(async (encoded) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + encoded;
        await image.decode();
        return [image.width, image.height];
      }, bytes.toString('base64'));
      expect(size).toEqual([340, 260]);
    }
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  await expect(canvas.locator('[data-canvas-target]')).toHaveCount(1);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(before);
  await page.screenshot({ path: info.outputPath('styled-hidden-geometry.png') });
}
