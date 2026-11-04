import { test, expect } from './fixtures';
import { mountR2, setR2, stateR2, paintR2, startR2 } from './canvas-r2-fixtures';
const directions = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
for (const resize of [undefined, true, false])
  for (const direction of directions)
    test(`A1/A5 ${String(resize)} resize ${direction} independent preview/commit/history`, async ({
      page,
    }, info) => {
      await mountR2(page, { resizeA: resize });
      const base = await stateR2(page),
        paint = await paintR2(page);
      const handle = page.getByRole('button', { name: 'Resize ' + direction, exact: true });
      if (resize === false) {
        await expect(handle).toHaveCount(0);
        await expect(page.locator('.selection-overlay > rect').first()).toBeVisible();
        expect(await stateR2(page)).toMatchObject({
          native: base.native,
          revision: 0,
          requests: 0,
          commits: 0,
        });
        return;
      }
      await expect(handle).toHaveAccessibleName('Resize ' + direction);
      await expect(handle).toHaveAttribute('aria-description', 'a');
      await startR2(page, 'resize', direction);
      await expect.poll(() => paintR2(page)).not.toEqual(paint);
      expect((await stateR2(page)).native).toEqual(base.native);
      await page.mouse.up();
      const changed = await stateR2(page);
      expect(changed).toMatchObject({ requests: 1, commits: 1, revision: 1, active: 0 });
      expect(changed.native).not.toEqual(base.native);
      await page.evaluate(() => window.r2Probe.undo());
      expect((await stateR2(page)).native).toEqual(base.native);
      await page.evaluate(() => window.r2Probe.redo());
      expect((await stateR2(page)).native).toEqual(changed.native);
      if (direction === 'se')
        await page.screenshot({ path: info.outputPath(`resize-${String(resize)}.png`) });
    });

for (const resize of [true, false])
  for (const rotate of [true, false])
    test(`A2 resizable=${resize} rotatable=${rotate} keeps move/nudge/selection`, async ({
      page,
    }) => {
      await mountR2(page, { resizeA: resize, rotateA: rotate });
      await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(resize ? 8 : 0);
      await expect(page.getByRole('button', { name: 'Rotate selection', exact: true })).toHaveCount(
        rotate ? 1 : 0,
      );
      const base = await stateR2(page);
      await startR2(page);
      await page.mouse.up();
      const moved = await stateR2(page);
      expect(moved.commits).toBe(1);
      expect(moved.native).not.toEqual(base.native);
      await page.getByRole('application').focus();
      await page.keyboard.press('ArrowRight');
      expect((await stateR2(page)).commits).toBe(2);
      if (rotate) {
        const before = await paintR2(page);
        await startR2(page, 'rotate');
        await page.mouse.up();
        expect((await paintR2(page))['data-rotation']).not.toBe(before['data-rotation']);
      }
    });

test('A3 mixed/all-true/empty/missing selection is atomic', async ({ page }) => {
  await mountR2(page, { resizeA: false, resizeB: true, selected: ['a', 'b'] });
  await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
  const base = await stateR2(page);
  await setR2(page, { resizeA: true });
  await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(8);
  await startR2(page, 'resize', 'e');
  await page.mouse.up();
  const changed = await stateR2(page);
  expect(changed.requests).toBe(1);
  for (const id of ['a', 'b'])
    expect(changed.native.items.find((i) => i.id === id)?.bounds).not.toEqual(
      base.native.items.find((i) => i.id === id)?.bounds,
    );
  for (const selected of [[], ['missing'], ['a', 'missing']]) {
    await setR2(page, { selected });
    await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
  }
});

for (const kind of ['group', 'frame'])
  test(`A3 ${kind} parent+child roots retain domain preview/commit semantics`, async ({ page }) => {
    const child = kind === 'group' ? 'child' : 'frame-child';
    await mountR2(page, { selected: [kind, child], resizeChild: true });
    await page.evaluate(() => window.r2Probe.camera({ zoom: 0.4 }));
    const base = await stateR2(page),
      oldChild = base.native.items.find((i) => i.id === child)!;
    await startR2(page, 'resize', 'se');
    const preview = await paintR2(page, child);
    expect((await stateR2(page)).native).toEqual(base.native);
    if (kind === 'frame') expect(preview.width).toBe(oldChild.bounds.width);
    else expect(preview.width).not.toBe(oldChild.bounds.width);
    await page.mouse.up();
    const changed = await stateR2(page);
    expect(changed.commits).toBe(1);
    expect(changed.native.items.find((i) => i.id === child)?.bounds.width).toBe(preview.width);
    await page.evaluate(() => window.r2Probe.undo());
    expect((await stateR2(page)).native).toEqual(base.native);
    await setR2(page, { resizeChild: false });
    await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
    await setR2(page, { selected: [kind] });
    await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(8);
    await setR2(page, { aggregateChildren: true });
    await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
  });

for (const reason of ['resize', 'deleted', 'readOnly', 'locked'])
  test(`A4 nonempty preview cancels before up on ${reason}`, async ({ page }, info) => {
    await mountR2(page);
    const original = await paintR2(page);
    const end = await startR2(page, 'resize', 'se');
    await expect.poll(() => paintR2(page)).not.toEqual(original);
    if (reason === 'resize') await setR2(page, { resizeA: false });
    if (reason === 'deleted') await page.evaluate(() => window.r2Probe.external(true));
    if (reason === 'readOnly') await setR2(page, { readOnly: true });
    if (reason === 'locked') await setR2(page, { lockedA: true });
    if (reason !== 'deleted') await expect.poll(() => paintR2(page)).toEqual(original);
    else await expect(page.getByTestId('paint-a')).toHaveCount(0);
    const cancelled = await stateR2(page);
    expect(cancelled).toMatchObject({ requests: 0, commits: 0, active: 0 });
    await setR2(page, { resizeA: true, readOnly: false, lockedA: false });
    await page.mouse.move(end.x + 7, end.y + 4);
    await page.mouse.up();
    const after = await stateR2(page);
    expect(after).toMatchObject({
      native: cancelled.native,
      revision: cancelled.revision,
      canUndo: cancelled.canUndo,
      requests: 0,
      commits: 0,
      active: 0,
    });
    if (reason === 'resize')
      await page.screenshot({ path: info.outputPath('capability-cancel.png') });
  });

for (const mode of ['move', 'resize', 'rotate'])
  test(`B1/B3 ${mode} revision update replaces nonempty preview with latest native before up`, async ({
    page,
  }, info) => {
    await mountR2(page);
    const base = await stateR2(page),
      original = await paintR2(page);
    const end = await startR2(page, mode);
    await expect.poll(() => paintR2(page)).not.toEqual(original);
    await page.evaluate(() => window.r2Probe.external());
    const updated = await stateR2(page);
    const actual = updated.native.items.find((i) => i.id === 'a')!;
    await expect
      .poll(() => paintR2(page))
      .toEqual({ ...actual.bounds, 'data-rotation': actual.rotation ?? 0 });
    expect(updated).toMatchObject({ requests: 0, commits: 0, active: 0, revision: 1 });
    await page.evaluate(() => {
      window.r2Probe.token('rev:0');
      window.r2Probe.rerender();
      window.r2Probe.advance();
      window.r2Probe.advance();
    });
    await page.mouse.move(end.x + 12, end.y + 8);
    await page.mouse.up();
    expect(await stateR2(page)).toMatchObject({
      native: updated.native,
      revision: 1,
      requests: 0,
      commits: 0,
      active: 0,
    });
    await page.screenshot({ path: info.outputPath(`revision-${mode}.png`) });
    await page.evaluate(() => window.r2Probe.undo());
    expect((await stateR2(page)).native).toEqual(base.native);
    await page.evaluate(() => window.r2Probe.redo());
    expect((await stateR2(page)).native).toEqual(updated.native);
  });

for (const optIn of [true, false])
  test(`B2 optIn=${optIn}: fresh projections/callbacks and camera keep a valid gesture`, async ({
    page,
  }) => {
    await mountR2(page, { optIn });
    const base = await stateR2(page);
    await startR2(page);
    await page.evaluate(() => {
      window.r2Probe.rerender();
      window.r2Probe.camera({ pan: { x: 15, y: 14 }, zoom: 0.9 });
    });
    expect((await stateR2(page)).active).toBe(1);
    await page.mouse.up();
    const after = await stateR2(page);
    expect(after).toMatchObject({ commits: 1, requests: 1, revision: 1, active: 0 });
    await page.evaluate(() => window.r2Probe.undo());
    expect((await stateR2(page)).native).toEqual(base.native);
    await page.evaluate(() => window.r2Probe.redo());
    expect((await stateR2(page)).native).toEqual(after.native);
  });

for (const mode of ['move', 'resize', 'rotate'])
  test(`B3 review: ${mode} cancellation then outside pointerup permits a fresh keyboard command`, async ({
    page,
  }, info) => {
    await mountR2(page);
    const base = await stateR2(page),
      original = await paintR2(page);
    await startR2(page, mode);
    await expect.poll(() => paintR2(page)).not.toEqual(original);
    await page.evaluate(() => window.r2Probe.external());
    const updated = await stateR2(page);
    await expect
      .poll(() => paintR2(page))
      .toEqual({
        ...updated.native.items[0].bounds,
        'data-rotation': 0,
      });
    expect(updated).toMatchObject({ requests: 0, commits: 0, active: 0, revision: 1 });
    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="stage-host"]')!;
      window.addEventListener(
        'pointerup',
        (e) => {
          document.body.dataset.outsidePointerup = String(!host.contains(e.target as Node));
        },
        { capture: true, once: true },
      );
    });
    await page.mouse.move(5, page.viewportSize()!.height - 8);
    await page.mouse.up();
    await expect(page.locator('body')).toHaveAttribute('data-outside-pointerup', 'true');
    expect(await stateR2(page)).toMatchObject({
      native: updated.native,
      requests: 0,
      commits: 0,
      revision: 1,
    });
    // focus() sends no new pointerdown: a click would mask a leaked Host precondition.
    await page.getByRole('application').focus();
    await page.keyboard.press('ArrowRight');
    const nudged = await stateR2(page);
    expect(nudged).toMatchObject({ requests: 1, commits: 1, revision: 2, active: 0, error: '' });
    expect(nudged.native.items[0].bounds).toEqual({
      ...updated.native.items[0].bounds,
      x: updated.native.items[0].bounds.x + 1,
    });
    await page.evaluate(() => window.r2Probe.undo());
    expect((await stateR2(page)).native).toEqual(updated.native);
    await page.evaluate(() => window.r2Probe.redo());
    expect((await stateR2(page)).native).toEqual(nudged.native);
    await page.screenshot({ path: info.outputPath('outside-release-nudge.png') });
    await page.evaluate(() => {
      window.r2Probe.undo();
      window.r2Probe.undo();
    });
    expect(await stateR2(page)).toMatchObject({ native: base.native, canUndo: false });
  });

test('B2 omission retains revision-unaware old preview behavior; Host precondition still rejects stale commit', async ({
  page,
}) => {
  await mountR2(page, { optIn: false });
  const original = await paintR2(page);
  await startR2(page);
  await page.evaluate(() => window.r2Probe.external());
  const external = await stateR2(page);
  expect(await paintR2(page)).not.toEqual({
    ...external.native.items[0].bounds,
    'data-rotation': 0,
  });
  expect(await paintR2(page)).not.toEqual(original);
  await page.evaluate(() => {
    // Unrelated/older terminal events must not erase this pointer's stale guard.
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 999 }));
    const oldCancel = new PointerEvent('pointercancel', { pointerId: 1 });
    Object.defineProperty(oldCancel, 'timeStamp', { value: 0 });
    window.dispatchEvent(oldCancel);
  });
  await page.mouse.up();
  expect(await stateR2(page)).toMatchObject({
    native: external.native,
    revision: external.revision,
    requests: 1,
    commits: 0,
    active: 0,
    error: 'Host precondition rejected',
  });
});

test('B3 removing/reapplying opt-in cancels once and requires a fresh pointerdown', async ({
  page,
}) => {
  await mountR2(page);
  const base = await paintR2(page),
    end = await startR2(page);
  await expect.poll(() => paintR2(page)).not.toEqual(base);
  await setR2(page, { optIn: false });
  await expect.poll(() => paintR2(page)).toEqual(base);
  await setR2(page, { optIn: true });
  await page.mouse.move(end.x + 8, end.y + 8);
  await page.mouse.up();
  expect(await stateR2(page)).toMatchObject({ requests: 0, commits: 0, active: 0 });
  await startR2(page);
  await page.mouse.up();
  expect((await stateR2(page)).commits).toBe(1);
});

for (const mode of ['resize', 'revision', 'both'])
  test(`AB1 reentrant preview ${mode} cannot reinstall stale geometry or commit`, async ({
    page,
  }) => {
    await mountR2(page);
    const original = await paintR2(page);
    await page.evaluate(
      (m) => window.r2Probe.previewInvalidates(m),
      mode as 'resize' | 'revision' | 'both',
    );
    await startR2(page, 'resize');
    await expect.poll(() => paintR2(page)).toEqual(original);
    expect(await stateR2(page)).toMatchObject({ requests: 0, commits: 0, active: 0 });
    await page.mouse.up();
    expect((await stateR2(page)).requests).toBe(0);
  });
for (const mode of ['resize', 'revision'])
  test(`AB1 capture-release ${mode} update is checked immediately before commit`, async ({
    page,
  }) => {
    await mountR2(page);
    await startR2(page, 'resize');
    await page.evaluate((m) => window.r2Probe.releaseInvalidates(m), mode as 'resize' | 'revision');
    await page.mouse.up();
    expect(await stateR2(page)).toMatchObject({ requests: 0, commits: 0, revision: 0, active: 0 });
  });
for (const order of ['same', 'a-first', 'b-first'])
  test(`AB1 ${order} invalidation and rerender release once, never resume`, async ({ page }) => {
    await mountR2(page);
    const original = await paintR2(page),
      end = await startR2(page, 'resize');
    await expect.poll(() => paintR2(page)).not.toEqual(original);
    await page.evaluate((order) => {
      if (order === 'same')
        window.r2Probe.previewInvalidates('both'); // use a new move to flush both in one Host update
      else if (order === 'a-first') {
        window.r2Probe.set({ resizeA: false });
        window.r2Probe.advance();
      } else {
        window.r2Probe.advance();
        window.r2Probe.set({ resizeA: false });
      }
    }, order);
    if (order === 'same') await page.mouse.move(end.x + 3, end.y + 3);
    await expect.poll(() => paintR2(page)).toEqual(original);
    await page.evaluate(() => {
      window.r2Probe.rerender();
      window.r2Probe.set({ resizeA: true });
      window.r2Probe.token('rev:0');
      window.r2Probe.rerender();
    });
    await page.mouse.move(end.x + 10, end.y + 10);
    await page.mouse.up();
    expect(await stateR2(page)).toMatchObject({ requests: 0, commits: 0, active: 0 });
    expect((await stateR2(page)).releases).toBeLessThanOrEqual(1);
  });

for (const reason of ['resize', 'revision'] as const)
  test(`AB1 replacement pointerdown reads ${reason} updates flushed by old capture release`, async ({
    page,
  }) => {
    await mountR2(page);
    const base = await stateR2(page);
    await startR2(page, 'move');
    const handle = page.getByRole('button', { name: 'Resize se', exact: true });
    const box = (await handle.boundingBox())!;
    await page.evaluate((reason) => window.r2Probe.releaseInvalidates(reason), reason);
    // Synthetic second pointerdown while a real mouse pointer is still active.
    // This exercises replacement cleanup and a synchronous committed Host update.
    await handle.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });
    if (reason === 'resize') {
      expect(await stateR2(page)).toMatchObject({ active: 0, requests: 0 });
      await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
    } else expect((await stateR2(page)).active).toBe(1);
    await page.mouse.move(box.x + 30, box.y + 25, { steps: 3 });
    await page.mouse.up();
    const after = await stateR2(page);
    expect(after).toMatchObject({
      active: 0,
      requests: reason === 'resize' ? 0 : 1,
      commits: reason === 'resize' ? 0 : 1,
    });
    if (reason === 'resize') expect(after.native).toEqual(base.native);
    else {
      expect(after.native).not.toEqual(base.native);
      await page.evaluate(() => window.r2Probe.undo());
      expect((await stateR2(page)).native).toEqual(base.native);
      expect((await stateR2(page)).canUndo).toBe(false);
    }
  });

test('B4/B5 object token does not own points; vertex→nudge→Undo/Redo keeps focus/camera/history', async ({
  page,
}) => {
  await mountR2(page, { resizeA: false, point: true });
  const base = await stateR2(page);
  const handle = page.getByRole('button', { name: 'R2 vertex', exact: true });
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 25, b.y + 20, { steps: 3 });
  await expect(page.getByTestId('point-preview')).not.toHaveText('');
  await page.evaluate(() => window.r2Probe.advance());
  await expect(page.getByTestId('point-preview')).not.toHaveText('');
  await page.mouse.up();
  const vertex = await stateR2(page);
  expect(vertex.revision).toBe(1);
  await setR2(page, { point: false });
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  const moved = await stateR2(page);
  expect(moved.revision).toBe(2);
  expect(moved.native).not.toEqual(vertex.native);
  await page.keyboard.press('Control+z');
  expect((await stateR2(page)).native).toEqual(vertex.native);
  await page.keyboard.press('Control+z');
  expect((await stateR2(page)).native).toEqual(base.native);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  expect((await stateR2(page)).native).toEqual(moved.native);
  expect((await stateR2(page)).view).toEqual(base.view);
});

test('B5 revision cancellation retains selection, camera and native text/IME key guards', async ({
  page,
}) => {
  await mountR2(page);
  const base = await stateR2(page);
  await startR2(page);
  const input = page.getByLabel('Host text');
  await input.focus();
  await page.evaluate(() => window.r2Probe.advance());
  await expect(input).toBeFocused();
  expect((await stateR2(page)).selected).toEqual(base.selected);
  expect((await stateR2(page)).view).toEqual(base.view);
  await input.fill('日本語入力');
  await input.press('ArrowRight');
  expect((await stateR2(page)).requests).toBe(0);
  await page.mouse.up();
  const app = page.getByRole('application');
  await app.focus();
  await app.dispatchEvent('keydown', { key: 'ArrowRight', isComposing: true });
  await app.dispatchEvent('keydown', { key: 'Delete', isComposing: true });
  expect(await stateR2(page)).toMatchObject({ requests: 0, error: '' });
  await app.dispatchEvent('keydown', { key: 'Delete', isComposing: false });
  await expect(page.getByTestId('error')).toHaveText('Delete boundary reached');
});

for (const control of ['point', 'readOnly', 'lockedA'] as const)
  test(`A2 ${control} suppresses object resize without leaking callbacks`, async ({ page }) => {
    await mountR2(page, { [control]: true });
    await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
    const before = await stateR2(page);
    if (control !== 'point') {
      await startR2(page);
      await page.mouse.up();
    }
    expect(await stateR2(page)).toMatchObject({
      native: before.native,
      revision: before.revision,
      requests: 0,
      active: 0,
    });
  });

test('B5 actual Canvas text buffer/focus and composition survive an object-token change', async ({
  page,
}) => {
  await mountR2(page);
  await page.getByTestId('paint-a').dblclick();
  const text = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await expect(text).toBeVisible();
  await text.fill('編集中の日本語');
  await text.dispatchEvent('compositionstart', { data: '語' });
  const before = await stateR2(page);
  await page.evaluate(() => window.r2Probe.advance());
  await expect(text).toBeFocused();
  await expect(text).toContainText('編集中の日本語');
  await text.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(text).toBeVisible();
  expect(await stateR2(page)).toMatchObject({
    native: before.native,
    revision: before.revision,
    requests: 0,
  });
  await text.dispatchEvent('compositionend', { data: '語' });
  await text.press('Escape');
  await expect(text).toHaveCount(0);
  expect((await stateR2(page)).view).toEqual(before.view);
});

test('AB2 pointer selection uses browser touch in 390px emulation and mouse on desktop', async ({
  page,
}, info) => {
  await mountR2(page, { selected: [], resizeA: false });
  const target = page.getByTestId('paint-a');
  if (info.project.name === 'mobile') await target.tap();
  else await target.click();
  expect((await stateR2(page)).selected).toEqual(['a']);
  await expect(page.getByRole('button', { name: /^Resize / })).toHaveCount(0);
  expect(await stateR2(page)).toMatchObject({ revision: 0, commits: 0, active: 0 });
});
