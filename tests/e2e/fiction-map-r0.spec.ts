import { readFile } from 'node:fs/promises';
import { assertEditableGeometry } from '@editor-platform/geo-core';
import { test, expect } from './fixtures';
import {
  mount,
  native,
  svgPoints,
  revision,
  feature,
  screenPoint,
  clickAt,
  dragFrom,
  outsideReleaseThenNudge,
} from './fiction-map-r0-fixtures';

test('R2 review: outside pointerup after cancellation permits keyboard nudge and Undo/Redo', async ({
  page,
}, info) => {
  await outsideReleaseThenNudge(page, info.outputPath('outside-release-nudge.png'));
});

test('R0 P0/P1/P2: painted hit shapes, concave empty area, line stroke and overlapping regions', async ({
  page,
}) => {
  await mount(page);
  for (const id of ['city', 'river', 'concave', 'lower', 'upper']) {
    await expect(page.getByTestId('shape-' + id)).toHaveCount(1);
  }
  await clickAt(page, 'concave', 290, 170);
  await expect(page.getByTestId('selection')).toHaveText('concave');
  // Within concave AABB but outside filled polygon: should not select concave.
  await clickAt(page, 'concave', 410, 175);
  await expect(page.getByTestId('selection')).toHaveText('');
  // Stroke is 7 world units wide at zoom 1: a 3-unit offset hits, 8 does not.
  await clickAt(page, 'river', 150, 273);
  await expect(page.getByTestId('selection')).toHaveText('river');
  await clickAt(page, 'river', 150, 278);
  await expect(page.getByTestId('selection')).toHaveText('');
  await clickAt(page, 'upper', 620, 200);
  await expect(page.getByTestId('selection')).toHaveText('upper');
});

test('R0 P3: marquee uses AABB rather than exact concave intersection', async ({ page }) => {
  await mount(page);
  const p = await screenPoint(page, 'concave', 400, 160);
  await dragFrom(page, p, 20, 20);
  // This is an explicit expected limitation of the existing CanvasStage.
  await expect(page.getByTestId('selection')).toContainText('concave');
  await expect(page.locator('.selection-overlay > rect').first()).toBeVisible();
});

test('R0 P4: translation preview, vertex commit, resize refusal, and local undo', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave' }).click();
  const start = await native(page),
    oldRev = await revision(page);
  const p = await screenPoint(page, 'concave', 290, 170);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 25, p.y + 15, { steps: 6 });
  // Native must remain unchanged while the view shows the proposed translation.
  expect(await native(page)).toEqual(start);
  const moved = svgPoints(await page.getByTestId('shape-concave').getAttribute('points'));
  expect(moved).toEqual(
    feature(start, 'concave').points.map((p) => ({
      x: p.x + 25,
      y: p.y + 15,
    })),
  );
  await page.mouse.up();
  const translated = await native(page);
  expect(feature(translated, 'concave').points).toEqual(
    feature(start, 'concave').points.map((p) => ({ x: p.x + 25, y: p.y + 15 })),
  );
  expect(await revision(page)).toBe(oldRev + 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(start);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(translated);
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const preVertex = await native(page);
  const preVertexRev = await revision(page);
  const v = page.getByRole('button', { name: 'Vertex 0', exact: true });
  const b = (await v.boundingBox())!;
  await dragFrom(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 12, 9);
  const committedVertex = await native(page);
  const changed = feature(committedVertex, 'concave');
  const originalVertex = feature(preVertex, 'concave').points[0];
  expect(changed.points[0]).toEqual({
    x: originalVertex.x + 12,
    y: originalVertex.y + 9,
  });
  expect(changed.points[0]).toEqual(changed.points[changed.points.length - 1]);
  expect(await revision(page)).toBe(preVertexRev + 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(preVertex);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(committedVertex);
  const beforeCancel = await native(page),
    beforeCancelRev = await revision(page);
  const cancelHandle = page.getByRole('button', { name: 'Vertex 1', exact: true });
  const cb = (await cancelHandle.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 20, cb.y + cb.height / 2 + 10, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await native(page)).toEqual(beforeCancel);
  expect(await revision(page)).toBe(beforeCancelRev);
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const preResize = await native(page),
    preRev = await revision(page);
  // R2-a: unsupported resize has no UI; the Host boundary remains defensive.
  const beforeResizeDrawing = await page.getByTestId('shape-concave').getAttribute('points');
  await expect(page.getByRole('button', { name: 'Resize nw', exact: true })).toHaveCount(0);
  await expect(page.locator('.selection-overlay > rect').first()).toBeVisible();
  await page.evaluate(() => window.r0ProbeResize('nw'));
  expect(await page.getByTestId('shape-concave').getAttribute('points')).toBe(beforeResizeDrawing);
  expect(await native(page)).toEqual(preResize);
  expect(await revision(page)).toBe(preRev);
  await expect(page.getByTestId('error')).toContainText('Resize and rotation');
});

test('R0 P5: keyboard nudge and read-only command boundary', async ({ page }) => {
  await mount(page);
  await clickAt(page, 'city', 110, 105);
  await expect(page.getByTestId('selection')).toHaveText('city');
  const a = feature(await native(page), 'city').points[0].x;
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowRight');
  expect(feature(await native(page), 'city').points[0].x).toBe(a + 1);
  await page.getByLabel('Read only').check();
  const protectedContent = await native(page),
    oldRev = await revision(page);
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowRight');
  expect(await native(page)).toEqual(protectedContent);
  expect(await revision(page)).toBe(oldRev);
});

test('R0 P5: hidden regions do not produce an interactive painted target', async ({ page }) => {
  await mount(page);
  const original = await native(page);
  const priorHit = await screenPoint(page, 'concave', 290, 170);
  await page.getByRole('button', { name: 'Toggle hidden concave' }).click();
  await expect(page.getByTestId('shape-concave')).toHaveCount(0);
  await page.mouse.click(priorHit.x, priorHit.y);
  await expect(page.getByTestId('selection')).toHaveText('');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(original);
  await expect(page.getByTestId('shape-concave')).toHaveCount(1);
});

test('R0 P6: camera change is private, does not mutate content', async ({ page }) => {
  await mount(page);
  const before = await native(page),
    oldRev = await revision(page);
  const camera = await page.getByTestId('camera').textContent();
  await page.getByRole('application', { name: 'R0 map probe' }).dispatchEvent('wheel', {
    deltaX: 30,
    deltaY: 20,
    ctrlKey: false,
    metaKey: false,
    clientX: 300,
    clientY: 300,
  });
  await expect.poll(() => page.getByTestId('camera').textContent()).not.toBe(camera);
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(oldRev);
});

test('R0 P7 candidate: independent bundle smoke only (normal Host not covered)', async ({
  page,
}) => {
  // This verifies an independently built React Surface only. Normal-Host integration
  // and cross-Editor regression are NOT certified by this test.
  await mount(page);
  await expect(page.getByRole('application', { name: 'R0 map probe' })).toHaveCount(1);
  await expect(page.getByTestId('native')).toContainText('"concave"');
});

async function selectionBox(page: import('@playwright/test').Page) {
  return page
    .locator('.selection-overlay > rect')
    .first()
    .evaluate((node) => {
      const rect = node as SVGRectElement;
      return {
        x: rect.x.baseVal.value,
        y: rect.y.baseVal.value,
        width: rect.width.baseVal.value,
        height: rect.height.baseVal.value,
      };
    });
}

test('R0 P2: label ownership, paint order, hidden overlap and geometry AABB', async ({
  page,
}, info) => {
  await mount(page);
  const start = await native(page),
    rev = await revision(page);
  // Label lies outside the point's geometry bounds but has the same stable owner.
  await page.getByTestId('label-city').click();
  await expect(page.getByTestId('selection')).toHaveText('city');
  await clickAt(page, 'upper', 620, 200);
  await expect(page.getByTestId('selection')).toHaveText('upper');
  expect(await selectionBox(page)).toEqual({ x: 570, y: 155, width: 130, height: 105 });
  await page.getByRole('button', { name: 'Reverse paint order' }).click();
  await clickAt(page, 'lower', 620, 200);
  await expect(page.getByTestId('selection')).toHaveText('lower');
  expect(await native(page)).toEqual(start);
  expect(await revision(page)).toBe(rev);
  await page.getByRole('button', { name: 'Reverse paint order' }).click();
  await page.getByRole('button', { name: 'Toggle hidden upper' }).click();
  await clickAt(page, 'lower', 620, 200);
  await expect(page.getByTestId('selection')).toHaveText('lower');
  await expect(page.getByTestId('shape-upper')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(start);
  await clickAt(page, 'lower', 530, 120);
  const p = await screenPoint(page, 'upper', 620, 200);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('selection')).toHaveText('lower,upper');
  expect(await selectionBox(page)).toEqual({ x: 520, y: 110, width: 180, height: 150 });
  await page.getByRole('button', { name: 'Select concave' }).click();
  expect(await selectionBox(page)).toEqual({ x: 280, y: 80, width: 180, height: 145 });
  expect(await native(page)).toEqual(start);
  // AABB includes the notch; it is a frame, never an exact polygon hit surface.
  await page.screenshot({ path: info.outputPath('r0-concave-aabb.png') });
});

for (const mode of ['object', 'vertex'] as const) {
  test(`R0 P4: ${mode} pointercancel clears preview without a command or Undo entry`, async ({
    page,
  }) => {
    await mount(page);
    const initial = await native(page);
    await page.getByRole('button', { name: 'Select concave' }).click();
    const stage = page.getByRole('application', { name: 'R0 map probe' });
    await stage.focus();
    await page.keyboard.press('ArrowRight');
    const base = await native(page),
      rev = await revision(page);
    if (mode === 'vertex') await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
    const target =
      mode === 'vertex'
        ? page.getByRole('button', { name: 'Vertex 0', exact: true })
        : page.locator('[data-canvas-target="concave"]');
    const point =
      mode === 'vertex'
        ? await target
            .boundingBox()
            .then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }))
        : await screenPoint(page, 'concave', 291, 170);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 15, { steps: 5 });
    expect(await target.evaluate((el) => el.hasPointerCapture(1))).toBe(true);
    if (mode === 'vertex') await expect(page.getByTestId('vertex-preview')).not.toHaveText('');
    else
      expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).not.toEqual(
        feature(base, 'concave').points,
      );
    expect(await native(page)).toEqual(base);
    expect(await revision(page)).toBe(rev);
    await target.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await expect(page.getByTestId('vertex-preview')).toHaveText('');
    await page.mouse.move(point.x + 40, point.y + 30);
    await page.mouse.up();
    expect(await native(page)).toEqual(base);
    expect(await revision(page)).toBe(rev);
    expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).toEqual(
      feature(base, 'concave').points,
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await native(page)).toEqual(initial);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await native(page)).toEqual(base);
  });
}

test('R0 P4: revision invalidation discards vertex preview and preserves the newer command through Undo/Redo', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave' }).click();
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const base = await native(page),
    rev = await revision(page);
  const handle = page.getByRole('button', { name: 'Vertex 0', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 20, { steps: 5 });
  await expect(page.getByTestId('vertex-preview')).not.toHaveText('');
  // A real independent Session command while the pointer remains captured.
  await page
    .getByRole('button', { name: 'External revision' })
    .evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('vertex-preview')).toHaveText('');
  expect(await handle.evaluate((el) => el.hasPointerCapture(1))).toBe(false);
  const updated = await native(page);
  expect(feature(updated, 'river').points).toEqual(
    feature(base, 'river').points.map((p) => ({ ...p, y: p.y + 5 })),
  );
  expect(feature(updated, 'concave')).toEqual(feature(base, 'concave'));
  expect(await revision(page)).toBe(rev + 1);
  await page.mouse.move(box.x + 70, box.y + 50);
  await page.mouse.up();
  expect(await native(page)).toEqual(updated);
  expect(await revision(page)).toBe(rev + 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(base);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(updated);
});

test('R0 P5: locked targets and mixed selections reject whole moves and vertex edits', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Toggle locked concave' }).click();
  await clickAt(page, 'concave', 290, 170);
  await expect(page.getByTestId('selection')).toHaveText('concave');
  const base = await native(page),
    rev = await revision(page);
  await dragFrom(page, await screenPoint(page, 'concave', 290, 170), 20, 10);
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('error')).toHaveText('Locked feature');
  await page.keyboard.down('Shift');
  await clickAt(page, 'city', 110, 105);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('selection')).toHaveText('concave,city');
  await dragFrom(page, await screenPoint(page, 'city', 110, 105), 30, 15);
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowDown');
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
  await page.getByRole('button', { name: 'Select concave' }).click();
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const handle = page.getByRole('button', { name: 'Vertex 0', exact: true });
  await expect(handle).toHaveAttribute('aria-disabled', 'true');
  const b = (await handle.boundingBox())!;
  await dragFrom(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 20, 10);
  await expect(page.getByTestId('vertex-preview')).toHaveText('');
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(feature(await native(page), 'concave').locked).toBeUndefined();
});

test('R0 P5: composing keys and native text input keep canvas commands out', async ({ page }) => {
  await mount(page);
  await clickAt(page, 'city', 110, 105);
  const base = await native(page),
    rev = await revision(page);
  const stage = page.getByRole('application', { name: 'R0 map probe' });
  await stage.dispatchEvent('compositionstart', { data: '' });
  for (const key of ['ArrowRight', 'Delete', 'Backspace', 'Escape']) {
    await stage.dispatchEvent('keydown', { key, isComposing: true });
  }
  await expect(page.getByTestId('selection')).toHaveText('city');
  await expect(page.getByTestId('error')).toHaveText('');
  const input = page.getByRole('textbox', { name: 'Fixture text input' });
  await input.fill('日本語');
  await input.press('Backspace');
  await expect(input).toHaveValue('日本');
  await input.press('ArrowRight');
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
  await stage.dispatchEvent('compositionend', { data: '日本' });
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  expect(feature(await native(page), 'city').points[0]).toEqual({ x: 111, y: 105 });
  expect(await revision(page)).toBe(rev + 1);
  await page.getByRole('button', { name: 'Select concave' }).click();
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const vertex = page.getByRole('button', { name: 'Vertex 0', exact: true });
  const b = (await vertex.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 20);
  const preview = await page.getByTestId('vertex-preview').textContent();
  expect(preview).not.toBe('');
  await vertex.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(page.getByTestId('vertex-preview')).toHaveText(preview!);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('vertex-preview')).toHaveText('');
});

test('R0 P5: readOnly revocation cancels a vertex drag and guards nudge, Delete, Host Undo and commands', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave' }).click();
  const stage = page.getByRole('application', { name: 'R0 map probe' });
  await stage.focus();
  // Positive control: Delete reaches the fixture callback while editable.
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('error')).toHaveText('Delete not supported');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('error')).toHaveText('');
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const base = await native(page),
    rev = await revision(page);
  const vertex = page.getByRole('button', { name: 'Vertex 0', exact: true });
  const b = (await vertex.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 20);
  await expect(page.getByTestId('vertex-preview')).not.toHaveText('');
  await page
    .getByLabel('Read only', { exact: true })
    .evaluate((el) => (el as HTMLInputElement).click());
  await expect(page.getByTestId('vertex-preview')).toHaveText('');
  await page.mouse.up();
  await expect(vertex).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  await dragFrom(page, await screenPoint(page, 'concave', 291, 170), 20, 10);
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('error')).toHaveText('');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('error')).toHaveText('');
  // Host Undo is checked by its disabled button above. No keyboard-history
  // assertion: this independent fixture does not provide EditorHistoryContext.
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
  await page.getByRole('button', { name: 'External revision' }).click();
  await expect(page.getByTestId('error')).toHaveText('Read only');
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
});

test('R0 P6: virtualization culls offscreen paint but retains selected IDs and geometry across pan/zoom', async ({
  page,
}, info) => {
  await mount(page);
  const base = await native(page),
    rev = await revision(page);
  await page.getByLabel('Virtualize', { exact: true }).check();
  const stage = page.getByRole('application', { name: 'R0 map probe' });
  await stage.dispatchEvent('wheel', { deltaX: 2000, deltaY: 0, clientX: 300, clientY: 200 });
  await expect(page.getByTestId('shape-concave')).toHaveCount(0);
  await expect(page.getByTestId('shape-city')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select concave' }).click();
  await expect(page.getByTestId('shape-concave')).toHaveCount(1);
  await expect(page.getByTestId('shape-upper')).toHaveCount(0);
  await page.getByLabel('Virtualize', { exact: true }).uncheck();
  await expect(page.getByTestId('shape-upper')).toHaveCount(1);
  await page.getByLabel('Virtualize', { exact: true }).check();
  await stage.dispatchEvent('wheel', { deltaX: -2000, deltaY: 0, clientX: 300, clientY: 200 });
  await expect(page.getByTestId('shape-city')).toHaveCount(1);
  const beforeZoom = await screenPoint(page, 'concave', 290, 170);
  await stage.dispatchEvent('wheel', {
    deltaY: -80,
    deltaX: 0,
    ctrlKey: true,
    clientX: beforeZoom.x,
    clientY: beforeZoom.y,
  });
  await expect
    .poll(async () => JSON.parse((await page.getByTestId('camera').textContent())!).zoom)
    .toBeGreaterThan(1);
  const afterZoom = await screenPoint(page, 'concave', 290, 170);
  expect(afterZoom.x).toBeCloseTo(beforeZoom.x, 3);
  expect(afterZoom.y).toBeCloseTo(beforeZoom.y, 3);
  await clickAt(page, 'concave', 290, 170);
  await expect(page.getByTestId('selection')).toHaveText('concave');
  expect(await selectionBox(page)).toEqual({ x: 280, y: 80, width: 180, height: 145 });
  expect(await native(page)).toEqual(base);
  expect(await revision(page)).toBe(rev);
  await page.screenshot({ path: info.outputPath('r0-virtualized-zoom.png') });
});

for (const sample of [
  { name: 'tiny', origin: -0.0001, scale: 0.000001 },
  { name: 'large-positive', origin: 1_000_000_000, scale: 1_000_000 },
  { name: 'large-negative', origin: -1_000_000_000, scale: 1_000_000 },
]) {
  test(`R0 P6: ${sample.name} finite world coordinates fit, keep CSS-sized handles and native data`, async ({
    page,
  }, info) => {
    const points = [
      { x: 0, y: 0 },
      { x: 180, y: 0 },
      { x: 180, y: 150 },
      { x: 0, y: 150 },
      { x: 0, y: 0 },
    ].map((p) => ({
      x: sample.origin + p.x * sample.scale,
      y: sample.origin + p.y * sample.scale,
    }));
    const content = { features: [{ id: 'concave', kind: 'polygon', points }] };
    await page.addInitScript(
      (value) => sessionStorage.setItem('r0-fixture', JSON.stringify(value)),
      { content, virtualize: true },
    );
    await mount(page);
    await page.getByRole('button', { name: 'Fit page', exact: true }).click();
    await page.getByRole('button', { name: 'Select concave' }).click();
    await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
    const stage = page.getByRole('application', { name: 'R0 map probe' });
    const stageBox = (await stage.boundingBox())!;
    const vertex = page.getByRole('button', { name: 'Vertex 0', exact: true });
    await expect.poll(async () => (await vertex.boundingBox())?.width).toBeCloseTo(11.5, 1);
    for (const handle of await page.locator('[data-path-point]').all()) {
      const b = (await handle.boundingBox())!;
      expect(b.width).toBeCloseTo(11.5, 1);
      expect(b.height).toBeCloseTo(11.5, 1);
      expect(b.x).toBeGreaterThanOrEqual(stageBox.x);
      expect(b.y).toBeGreaterThanOrEqual(stageBox.y);
      expect(b.x + b.width).toBeLessThanOrEqual(stageBox.x + stageBox.width);
      expect(b.y + b.height).toBeLessThanOrEqual(stageBox.y + stageBox.height);
    }
    expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).toEqual(
      points,
    );
    const point = await screenPoint(page, 'concave', points[0].x, points[0].y);
    const b = (await vertex.boundingBox())!;
    expect(point.x).toBeCloseTo(b.x + b.width / 2, 1);
    expect(point.y).toBeCloseTo(b.y + b.height / 2, 1);
    const camera = JSON.parse((await page.getByTestId('camera').textContent())!);
    expect(Number.isFinite(camera.zoom) && camera.zoom > 0).toBe(true);
    const revisionBefore = await revision(page);
    await stage.dispatchEvent('wheel', {
      deltaX: 15,
      deltaY: 10,
      clientX: point.x,
      clientY: point.y,
    });
    await expect
      .poll(() => page.getByTestId('camera').textContent())
      .not.toBe(JSON.stringify(camera));
    await stage.dispatchEvent('wheel', {
      deltaX: 0,
      deltaY: 30,
      ctrlKey: true,
      clientX: point.x,
      clientY: point.y,
    });
    expect(await native(page)).toEqual(content);
    expect(await revision(page)).toBe(revisionBefore);
    await page.screenshot({ path: info.outputPath(`r0-${sample.name}.png`) });
  });
}

test('R0 P7: fixture imports only public entrypoints', async () => {
  const source = await readFile('tests/fixtures/fiction-map-r0/host.tsx', 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  expect(imports.sort()).toEqual(
    [
      'react',
      'react-dom/client',
      '@editor-platform/canvas-ui',
      '@editor-platform/canvas-ui/path-handles',
      '@editor-platform/editor-core',
    ].sort(),
  );
});

test('R0 R1 boundary: Geo longitude and fixed tolerance validation are not unit-free planar validation', () => {
  // Both rings are finite, explicitly closed, simple planar polygons. Their
  // rejection is Geo's existing contract, not an error to fix in Geo for R0.
  expect(() =>
    assertEditableGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [120, 0],
          [240, 100],
          [0, 0],
        ],
      ],
    }),
  ).toThrow('polygon-ambiguous-wrap');
  expect(() =>
    assertEditableGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1e-6, 0],
          [1e-6, 1e-6],
          [0, 1e-6],
          [0, 0],
        ],
      ],
    }),
  ).toThrow('polygon-zero-area');
});

for (const direction of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
  test(`R2-a: resize ${direction} opt-out retains the independent Host rejection boundary`, async ({
    page,
  }, info) => {
    await mount(page);
    await page.getByRole('button', { name: 'Select concave' }).click();
    const base = await native(page),
      rev = await revision(page);
    await expect(page.getByTestId('error')).toHaveText('');
    await expect(
      page.getByRole('button', { name: 'Resize ' + direction, exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.selection-overlay > rect').first()).toBeVisible();
    await expect(page.getByTestId('transform-requests')).toHaveText('0');
    expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).toEqual(
      feature(base, 'concave').points,
    );
    expect(await native(page)).toEqual(base);
    await expect(page.getByTestId('error')).toHaveText('');
    await page.evaluate((d) => window.r0ProbeResize(d), direction);
    await expect(page.getByTestId('transform-requests')).toHaveText('1');
    await expect(page.getByTestId('error')).toHaveText(
      'Resize and rotation are not supported for map features',
    );
    expect(await native(page)).toEqual(base);
    expect(await revision(page)).toBe(rev);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('.selection-overlay [role="button"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`r2-disabled-resize-${direction}.png`) });
  });
}

test('R0 P4 regression: vertex commit followed immediately by object keyboard nudge keeps history usable', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave' }).click();
  const start = await native(page),
    rev = await revision(page);
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  const vertex = page.getByRole('button', { name: 'Vertex 0', exact: true });
  const b = (await vertex.boundingBox())!;
  await dragFrom(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 12, 9);
  const afterVertex = await native(page);
  const expectedVertex = {
    features: start.features.map((f) =>
      f.id !== 'concave'
        ? f
        : {
            ...f,
            points: f.points.map((p, i) =>
              i === 0 || i === f.points.length - 1 ? { x: p.x + 12, y: p.y + 9 } : p,
            ),
          },
    ),
  };
  expect(afterVertex).toEqual(expectedVertex);
  expect(await revision(page)).toBe(rev + 1);
  await page.getByRole('button', { name: 'Toggle vertex mode' }).click();
  // Do not click the canvas: a new pointerdown would hide the stale-revision bug.
  await page.getByRole('application', { name: 'R0 map probe' }).focus();
  await page.keyboard.press('ArrowRight');
  const afterNudge = {
    features: afterVertex.features.map((f) =>
      f.id !== 'concave'
        ? f
        : {
            ...f,
            points: f.points.map((p) => ({ x: p.x + 1, y: p.y })),
          },
    ),
  };
  await expect(page.getByTestId('error')).toHaveText('');
  expect(await native(page)).toEqual(afterNudge);
  expect(await revision(page)).toBe(rev + 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(afterVertex);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(start);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(afterVertex);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(afterNudge);
});

test('R2-b: object revision invalidation clears preview before release and preserves the external command', async ({
  page,
}, info) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave' }).click();
  const base = await native(page),
    rev = await revision(page);
  const p = await screenPoint(page, 'concave', 290, 170);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 20, p.y + 15, { steps: 5 });
  expect(await native(page)).toEqual(base);
  expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).not.toEqual(
    feature(base, 'concave').points,
  );
  await expect(page.getByTestId('transform-requests')).toHaveText('0');
  await page
    .getByRole('button', { name: 'External revision' })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const updated = await native(page);
  expect(feature(updated, 'river').points).toEqual(
    feature(base, 'river').points.map((p) => ({ ...p, y: p.y + 5 })),
  );
  expect(feature(updated, 'concave')).toEqual(feature(base, 'concave'));
  // R2-b removes stale UI before pointerup; Host preconditions remain in the fixture.
  await expect
    .poll(async () => svgPoints(await page.getByTestId('shape-concave').getAttribute('points')))
    .toEqual(feature(base, 'concave').points);
  await page.screenshot({ path: info.outputPath('r2-object-preview-cancel.png') });
  await page.mouse.up();
  await expect(page.getByTestId('error')).toHaveText('');
  await expect(page.getByTestId('transform-requests')).toHaveText('0');
  expect(await native(page)).toEqual(updated);
  expect(await revision(page)).toBe(rev + 1);
  expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).toEqual(
    feature(base, 'concave').points,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(base);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(updated);
});
