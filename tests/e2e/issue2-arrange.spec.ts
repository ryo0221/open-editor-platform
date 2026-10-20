import { test, expect, create, nativeArtifact } from './fixtures';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide';

async function snapshot(page: Page) {
  return (await nativeArtifact(page)).draft.content as SlideContent;
}
async function number(page: Page, label: string, value: number) {
  await page.getByLabel(label, { exact: true }).fill(String(value));
  await page.getByLabel(label, { exact: true }).press('Enter');
}
async function arrange(page: Page, label: string) {
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.keyboard.press('Escape');
}
async function shapes(page: Page) {
  await page.goto('/');
  await create(page, 'slide');
  for (const [i, name] of ['triangle', 'ellipse', 'star'].entries()) {
    await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
    await page.getByRole('button', { name: `Insert ${name}`, exact: true }).click();
    await page.keyboard.press('Escape');
    for (const [label, value] of [
      ['Element x', 80 + 220 * i],
      ['Element y', 70 + 120 * i],
      ['Element width', 100 + 25 * i],
      ['Element height', 60 + 10 * i],
    ] as const)
      await number(page, label, value);
  }
}

test('QA-03 shape picker has distinct outlines, keyboard activation, search and recent shapes', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'slide');
  const insert = page.getByRole('button', { name: 'Insert shapes', exact: true });
  await insert.focus();
  await page.keyboard.press('Enter');
  const triangle = page.getByRole('button', { name: 'Insert triangle', exact: true });
  const ellipse = page.getByRole('button', { name: 'Insert ellipse', exact: true });
  expect(await triangle.locator('img').getAttribute('src')).not.toBe(
    await ellipse.locator('img').getAttribute('src'),
  );
  await page.getByLabel('Search shapes', { exact: true }).fill('triangle');
  await expect(ellipse).toBeHidden();
  await triangle.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(insert).toBeFocused();
  expect((await snapshot(page)).slides[0].objects[0].shape).toBe('triangle');
  await insert.click();
  await page.getByLabel('Shape category', { exact: true }).selectOption('Recent');
  await expect(triangle).toBeVisible();
  await page.keyboard.press('Escape');
});

test('QA-04 six alignments, both distributions and explicit gaps are atomic and reject locked selections', async ({
  page,
}) => {
  test.setTimeout(90000);
  await shapes(page);
  const canvas = page.getByRole('application', { name: 'Slide canvas' });
  await canvas.focus();
  await canvas.press('Control+a');
  const before = await snapshot(page);
  for (const mode of ['left', 'center', 'right', 'top', 'middle', 'bottom']) {
    await arrange(page, `Align ${mode}`);
    const bounds = (await snapshot(page)).slides[0].objects.map((o) => o.bounds);
    const values = bounds.map((b) =>
      mode === 'left'
        ? b.x
        : mode === 'center'
          ? b.x + b.width / 2
          : mode === 'right'
            ? b.x + b.width
            : mode === 'top'
              ? b.y
              : mode === 'middle'
                ? b.y + b.height / 2
                : b.y + b.height,
    );
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.01);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await snapshot(page)).toEqual(before);
  }
  for (const axis of ['x', 'y'] as const) {
    for (const gap of [undefined, 24]) {
      if (gap === undefined)
        await arrange(page, `Distribute ${axis === 'x' ? 'horizontally' : 'vertically'}`);
      else {
        await page.getByRole('button', { name: 'Arrange', exact: true }).click();
        await number(page, `${axis === 'x' ? 'Horizontal' : 'Vertical'} gap (px)`, gap);
        await page.keyboard.press('Escape');
      }
      const bounds = (await snapshot(page)).slides[0].objects
        .map((o) => o.bounds)
        .sort((a, b) => a[axis] - b[axis]);
      const size = axis === 'x' ? 'width' : 'height';
      const gaps = [
        bounds[1][axis] - bounds[0][axis] - bounds[0][size],
        bounds[2][axis] - bounds[1][axis] - bounds[1][size],
      ];
      expect(gaps[0]).toBeCloseTo(gaps[1]);
      if (gap !== undefined) expect(gaps[0]).toBe(gap);
      else expect(bounds[2][axis]).toBe(before.slides[0].objects[2].bounds[axis]);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await snapshot(page)).toEqual(before);
    }
  }
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle lock 2', exact: true }).click();
  const locked = await snapshot(page);
  await arrange(page, 'Align left');
  await expect(page.getByRole('alert').last()).toContainText('Unlock');
  expect(await snapshot(page)).toEqual(locked);
});

test('QA-06 nested groups transform, duplicate, cut/paste and ungroup with stable references and atomic undo', async ({
  page,
}) => {
  test.setTimeout(90000);
  await shapes(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  const select = async (type: string, i: number, shift = false) =>
    page
      .getByRole('button', { name: `Select ${type} object ${i}`, exact: true })
      .click({ modifiers: shift ? ['Shift'] : [] });
  await select('shape', 1);
  await select('shape', 2, true);
  await arrange(page, 'Group');
  await select('group', 1);
  await select('shape', 4, true);
  await arrange(page, 'Group');
  await select('group', 1);
  const before = await snapshot(page),
    objects = before.slides[0].objects;
  expect(objects.filter((o) => o.type === 'group')).toHaveLength(2);
  await number(page, 'Element width', objects[0].bounds.width * 1.5);
  const scaled = await snapshot(page);
  for (const object of scaled.slides[0].objects.slice(1)) {
    const old = objects.find((o) => o.id === object.id)!;
    expect(object.bounds.width).toBeCloseTo(old.bounds.width * 1.5);
    expect(object.bounds.x - scaled.slides[0].objects[0].bounds.x).toBeCloseTo(
      (old.bounds.x - objects[0].bounds.x) * 1.5,
    );
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.keyboard.press('Escape');
  const duplicated = await snapshot(page),
    copies = duplicated.slides[0].objects.slice(5);
  expect(copies).toHaveLength(5);
  expect(copies.map((o) => o.bounds)).toEqual(
    objects.map((o) => ({ ...o.bounds, x: o.bounds.x + 20, y: o.bounds.y + 20 })),
  );
  const ids = new Set(copies.map((o) => o.id));
  for (const copy of copies) {
    expect(objects.some((o) => o.id === copy.id)).toBe(false);
    if (copy.groupId) expect(ids.has(copy.groupId)).toBe(true);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await snapshot(page)).toEqual(duplicated);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await select('group', 1);
  await arrange(page, 'Ungroup');
  const ungrouped = await snapshot(page);
  for (const o of ungrouped.slides[0].objects)
    expect(o.bounds).toEqual(objects.find((old) => old.id === o.id)!.bounds);
  expect(ungrouped.slides[0].objects.filter((o) => o.type === 'group')).toHaveLength(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await select('group', 1);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Cut', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await snapshot(page)).slides[0].objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await page.keyboard.press('Escape');
  const pasted = (await snapshot(page)).slides[0].objects;
  expect(pasted).toHaveLength(5);
  expect(pasted.map((o) => o.bounds)).toEqual(objects.map((o) => o.bounds));
  const pastedIds = new Set(pasted.map((o) => o.id));
  expect(pasted.filter((o) => o.groupId).every((o) => pastedIds.has(o.groupId!))).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await snapshot(page)).slides[0].objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
});
