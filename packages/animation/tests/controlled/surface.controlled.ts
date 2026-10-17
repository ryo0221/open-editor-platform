import { test as base, expect } from '@playwright/test';
const test = base.extend<{ errors: void }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
test('one aggregate commit and one Host Undo; identity-only refresh retains raw input', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '960000 ticks · 400', exact: true }).click();
  await page.getByLabel('Base y', { exact: true }).fill('160');
  await page.getByLabel('Key tick', { exact: true }).fill('720000');
  await page.getByLabel('Key value', { exact: true }).fill('500');
  await page.evaluate(() => window.controlledTest.cloneView());
  await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('160');
  expect(
    await page.evaluate(
      () => window.controlledTest.inspect().content.compositions[0].layers[0].transform.y,
    ),
  ).toBe(140);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.controlledTest.nonUI())).toMatchObject({
    state: 'refused',
  });
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  const state = await page.evaluate(() => window.controlledTest.inspect());
  expect(state.revision.sequence).toBe(1);
  expect(state.bound).toBe(1);
  expect(state.content.compositions[0].layers[0].transform.y).toBe(160);
  expect(state.content.compositions[0].tracks[0].keys[1]).toMatchObject({
    tick: 720000,
    value: 500,
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    await page.evaluate(
      () => window.controlledTest.inspect().content.compositions[0].layers[0].transform.y,
    ),
  ).toBe(140);
  await expect(page.getByRole('button', { name: '960000 ticks · 400', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: '720000 ticks · 500', exact: true })).toBeVisible();
  await page.getByLabel('Seek', { exact: true }).fill('360000');
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 290 160)');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: info.outputPath('controlled.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('Host save flushes once, invalid and IME block atomically; Cancel and no-op preserve canonical history', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '960000 ticks · 400', exact: true }).click();
  await page.getByLabel('Base y', { exact: true }).fill('170');
  await page.getByLabel('Key tick', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('already exists');
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
  await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('170');
  await page.getByLabel('Key tick', { exact: true }).fill('720000');
  await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionstart');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('IME');
  await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Save: committed');
  let state = await page.evaluate(() => window.controlledTest.inspect());
  expect(state.revision.sequence).toBe(1);
  expect(JSON.parse(state.stored!).compositions[0].layers[0].transform.y).toBe(170);
  expect(state.pending).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByLabel('Base y', { exact: true }).fill('');
  await page.getByLabel('Base y', { exact: true }).fill('140');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(
    await page.evaluate(
      () => window.controlledTest.inspect().content.compositions[0].layers[0].transform.y,
    ),
  ).toBe(170);
  await page.getByLabel('Base x', { exact: true }).fill('-');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('complete number');
  await expect(page.getByLabel('Base x', { exact: true })).toHaveValue('-');
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  state = await page.evaluate(() => window.controlledTest.inspect());
  expect(state.pending).toBe(false);
  expect(state.revision.sequence).toBe(3);
});
test('readonly does not bind inputs; revoke detaches presentation and unregisters one group', async ({
  page,
}) => {
  await page.goto('/?readonly');
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save through Host', exact: true })).toBeDisabled();
  await expect(page.locator('svg')).toHaveCount(1);
  expect(await page.evaluate(() => window.controlledTest.inspect().bound)).toBe(0);
  await page.goto('/');
  await expect(page.locator('svg')).toHaveCount(1);
  await page.getByLabel('Base y', { exact: true }).fill('190');
  await page.evaluate(() => window.controlledTest.revoke());
  await expect(page.getByRole('status')).toHaveText('Animation scope revoked');
  await expect(page.locator('svg')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.controlledTest.inspect().bound)).toBe(0);
  expect(await page.evaluate(() => window.controlledTest.inspect().detached)).toBe(1);
  expect(await page.evaluate(() => window.controlledTest.nonUI())).toMatchObject({
    state: 'refused',
  });
});

test('save reports noncommitted Host outcomes exactly without claiming a write', async ({
  page,
}) => {
  await page.goto('/');
  for (const mode of ['aborted-before-write', 'indeterminate'] as const) {
    await page.evaluate((m) => window.controlledTest.setSaveMode(m), mode);
    await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(`Save: ${mode}`);
    expect(await page.evaluate(() => window.controlledTest.inspect().stored)).toBeNull();
  }
  await page.evaluate(() => window.controlledTest.unmount());
  expect(await page.evaluate(() => window.controlledTest.inspect())).toMatchObject({
    bound: 0,
    detached: 1,
  });
});

for (const target of ['layer', 'composition', 'command'] as const)
  test(`cancelled IME without change reseeds after ${target}`, async ({ page }) => {
    await page.goto('/?multi');
    const field = page.getByLabel('Base y', { exact: true });
    await field.dispatchEvent('compositionstart');
    await expect(page.getByLabel('Composition', { exact: true })).toBeDisabled();
    await field.dispatchEvent('compositionend');
    await expect(page.getByLabel('Composition', { exact: true })).toBeEnabled();
    if (target === 'layer')
      await page.getByRole('button', { name: 'rect other-box', exact: true }).click();
    if (target === 'composition')
      await page.getByLabel('Composition', { exact: true }).selectOption('other-composition');
    if (target === 'command')
      expect(await page.evaluate(() => window.controlledTest.nonUI())).toMatchObject({
        state: 'applied',
      });
    await field.fill('205');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('applied');
    const state = await page.evaluate(() => window.controlledTest.inspect());
    const root = state.content.compositions[0];
    if (target === 'layer') {
      expect(root.layers[0].transform.y).toBe(140);
      expect(root.layers[1].transform.y).toBe(205);
    }
    if (target === 'composition') {
      expect(root.layers[0].transform.y).toBe(140);
      expect(state.content.compositions[1].layers[0].transform.y).toBe(205);
    }
    if (target === 'command') {
      expect(root.layers[0].transform.y).toBe(205);
      expect(state.revision.sequence).toBe(2);
    }
  });

test('ending another empty IME keeps existing dirty values and active composition', async ({
  page,
}) => {
  await page.goto('/?multi');
  const y = page.getByLabel('Base y', { exact: true }),
    x = page.getByLabel('Base x', { exact: true });
  await y.dispatchEvent('compositionstart');
  await y.fill('175');
  await x.dispatchEvent('compositionstart');
  await x.dispatchEvent('compositionend');
  await expect(y).toHaveValue('175');
  await expect(page.getByRole('button', { name: 'rect other-box', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('IME');
  await y.dispatchEvent('compositionend');
  await expect(y).toHaveValue('175');
  await expect(page.getByRole('button', { name: 'rect other-box', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('applied');
  expect(
    await page.evaluate(
      () => window.controlledTest.inspect().content.compositions[0].layers[0].transform.y,
    ),
  ).toBe(175);
});

test('timeline keyboard preview blocks Host save/nonUI; cancel and commit preserve one Undo', async ({
  page,
}) => {
  await page.goto('/');
  const marker = page.getByRole('button', { name: '960000 ticks · 400', exact: true });
  await marker.focus();
  await marker.press('Shift+ArrowLeft');
  await expect(page.getByText(/Preview: 952000 ticks/)).toBeVisible();
  expect(await page.evaluate(() => window.controlledTest.nonUI())).toMatchObject({
    state: 'refused',
  });
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
  await marker.press('Escape');
  expect(await page.evaluate(() => window.controlledTest.inspect().pending)).toBe(false);
  await marker.press('Shift+ArrowLeft');
  await marker.press('Enter');
  await expect(page.getByRole('button', { name: '952000 ticks · 400', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(marker).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: '952000 ticks · 400', exact: true })).toBeVisible();
});
test('easing uses Host atomic input flush, retains invalid/IME, renders Hold, saves curve', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
  await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
  await page.getByLabel('Bezier x1', { exact: true }).fill('-');
  await page.getByLabel('Base y', { exact: true }).fill('175');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('complete number');
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
  await expect(page.getByLabel('Bezier x1', { exact: true })).toHaveValue('-');
  await page.getByLabel('Bezier x1', { exact: true }).fill('0.25');
  await page.getByLabel('Bezier x1', { exact: true }).dispatchEvent('compositionstart');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('IME');
  await page.getByLabel('Bezier x1', { exact: true }).dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Save: committed');
  const state = await page.evaluate(() => window.controlledTest.inspect());
  expect(state.revision.sequence).toBe(1);
  expect(JSON.parse(state.stored!).compositions[0].tracks[0].keys[0].easing).toMatchObject({
    type: 'bezier',
    x1: 0.25,
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('140');
  await page.getByLabel('Easing', { exact: true }).selectOption('linear');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Bezier x1', { exact: true })).toHaveValue('0.25');
  await page.getByLabel('Easing', { exact: true }).selectOption('hold');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await page.getByLabel('Seek', { exact: true }).fill('480000');
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 80 175)');
});

test('zoom persists across key edits and Undo; invalid endpoint and pointer cancel leave no pending draft', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Timeline zoom', { exact: true }).fill('2');
  const end = page.getByRole('button', { name: '960000 ticks · 400', exact: true });
  await end.focus();
  await end.press('ArrowRight');
  await end.press('Enter');
  await expect(page.getByRole('status')).toContainText('outside');
  expect(await page.evaluate(() => window.controlledTest.inspect().pending)).toBe(false);
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
  await end.press('Shift+ArrowLeft');
  await end.press('Enter');
  await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('2');
  await end.scrollIntoViewIfNeeded();
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await end.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.controlledTest.inspect().pending)).toBe(false);
});

for (const mode of ['applyInputs', 'flush'] as const)
  for (const easing of ['hold', 'bezier'] as const)
    test(`synchronous Inputs subscriber ${mode} commits complete ${easing} draft once`, async ({
      page,
    }) => {
      await page.goto('/');
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
      await page.evaluate((m) => window.controlledTest.armSynchronousFlush(m), mode);
      await page.getByLabel('Easing', { exact: true }).selectOption(easing);
      const state = await page.evaluate(() => window.controlledTest.inspect());
      expect(state.synchronousFlushes).toBe(1);
      expect(state.content.compositions[0].tracks[0].keys[0].easing).toEqual(
        easing === 'hold' ? { type: 'hold' } : { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      );
      expect(state.revision.sequence).toBe(1);
      expect(state.pending).toBe(false);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(
        await page.evaluate(
          () => window.controlledTest.inspect().content.compositions[0].tracks[0].keys[0].easing,
        ),
      ).toEqual({ type: 'linear' });
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect(
        await page.evaluate(
          () =>
            window.controlledTest.inspect().content.compositions[0].tracks[0].keys[0].easing.type,
        ),
      ).toBe(easing);
    });

test('new rectangle becomes the editing target without changing the previous layer', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const state = await page.evaluate(() => window.controlledTest.inspect());
  const added = state.content.compositions[0].layers.at(-1)!;
  await expect(page.getByRole('button', { name: `rect ${added.id}`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Base y', { exact: true }).fill('220');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  const after = await page.evaluate(() => window.controlledTest.inspect());
  expect(after.content.compositions[0].layers[0].transform.y).toBe(140);
  expect(after.content.compositions[0].layers.at(-1)!.transform.y).toBe(220);
});
test('new key becomes editable immediately; duplicate refusal preserves the selection', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByLabel('Seek', { exact: true }).fill('480000');
  await page.getByRole('button', { name: 'Add key at playhead (base value)', exact: true }).click();
  await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('480000');
  await page.getByLabel('Key value', { exact: true }).fill('260');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add key at playhead (base value)', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('already exists');
  await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('480000');
  await expect(page.getByLabel('Key value', { exact: true })).toHaveValue('260');
});

test('creation selection stays private through dirty Cancel and layer Undo/Redo', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const created = (
    await page.evaluate(() => window.controlledTest.inspect())
  ).content.compositions[0].layers.at(-1)!;
  const selected = page.getByRole('button', { name: `rect ${created.id}`, exact: true });
  await page.getByLabel('Base y', { exact: true }).fill('220');
  await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Add key at playhead (base value)', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(1);
  await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('140');
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(page.getByLabel('Base y', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('navigation', { name: 'Layers' }).locator('[aria-pressed="true"]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Base y', { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(3);
});
test('Undo of created key leaves no editable ghost and Redo restores the same selected ID', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByLabel('Seek', { exact: true }).fill('480000');
  await page.getByRole('button', { name: 'Add key at playhead (base value)', exact: true }).click();
  const native = await page.evaluate(() => window.controlledTest.inspect().content);
  const created = native.compositions[0].tracks[0].keys.find((k) => k.tick === 480000)!;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Key value', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '480000 ticks · 80', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '480000 ticks · 80', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const state = await page.evaluate(() => window.controlledTest.inspect());
  expect(state.content.compositions[0].tracks[0].keys.find((k) => k.tick === 480000)!.id).toBe(
    created.id,
  );
  expect(state.content).toEqual(native);
  expect(state.revision.sequence).toBe(3);
});

test('keyboard retiming keeps the focused key visible in a zoomed timeline', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Timeline zoom', { exact: true }).fill('4');
  const first = page.getByRole('button', { name: '0 ticks · 80', exact: true });
  await first.focus();
  await page.keyboard.press('Tab');
  const end = page.getByRole('button', { name: '960000 ticks · 400', exact: true });
  await expect(end).toBeFocused();
  await expect(end).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
  for (let i = 0; i < 50; i++) await page.keyboard.press('Shift+ArrowLeft');
  const preview = (await page.locator('.ae-key-ghost').boundingBox())!;
  const scroll = (await page.getByLabel('Scrollable timeline', { exact: true }).boundingBox())!;
  expect(preview.x).toBeGreaterThanOrEqual(scroll.x);
  expect(preview.x + preview.width).toBeLessThanOrEqual(scroll.x + scroll.width);
  await page.keyboard.press('Enter');
  const moved = page.getByRole('button', { name: '560000 ticks · 400', exact: true });
  await expect(moved).toBeFocused();
  const marker = (await moved.boundingBox())!;
  const viewport = (await page.getByLabel('Scrollable timeline', { exact: true }).boundingBox())!;
  expect(marker.x).toBeGreaterThanOrEqual(viewport.x);
  expect(marker.x + marker.width).toBeLessThanOrEqual(viewport.x + viewport.width);
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(1);
});
test('Undo and Redo keep toolbar focus and explain a removed selected key', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByLabel('Seek', { exact: true }).fill('480000');
  await page.getByRole('button', { name: 'Add key at playhead (base value)', exact: true }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(undo).toBeFocused();
  await expect(
    page.getByText('Selected key is unavailable. Choose a key to continue.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Key value', { exact: true })).toBeDisabled();
  await page.keyboard.press('Tab');
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(redo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(redo).toBeFocused();
  await expect(
    page.getByRole('button', { name: '480000 ticks · 80', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText('Selected key is unavailable. Choose a key to continue.', {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(3);
});

for (const failure of ['Key tick', 'Bezier y2', 'IME Key value'] as const)
  test(`Save focuses ${failure} and keeps every pending field`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '960000 ticks · 400', exact: true }).click();
    await page.getByLabel('Base y', { exact: true }).fill('170');
    let target = page.getByLabel('Key tick', { exact: true });
    if (failure === 'Key tick') await target.fill('0');
    if (failure === 'Bezier y2') {
      await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
      target = page.getByLabel('Bezier y2', { exact: true });
      await target.fill('-');
    }
    if (failure === 'IME Key value') {
      target = page.getByLabel('Key value', { exact: true });
      await target.dispatchEvent('compositionstart');
    }
    await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
    await expect(target).toBeFocused();
    await expect(page.getByRole('alert')).toContainText(
      failure === 'IME Key value' ? 'IME' : failure,
    );
    await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('170');
    expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Property', { exact: true })).toBeDisabled();
    if (failure === 'IME Key value') await target.dispatchEvent('compositionend');
    if (failure === 'Key tick') await target.fill('720000');
    if (failure === 'Bezier y2') await target.fill('1');
    await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Save: committed');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('140');
  });

test('Cancel clears the addressed error without changing selected key or native history', async ({
  page,
}) => {
  await page.goto('/');
  const key = page.getByRole('button', { name: '960000 ticks · 400', exact: true });
  await key.click();
  await page.getByLabel('Base y', { exact: true }).fill('170');
  await page.getByLabel('Key tick', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  await expect(page.getByLabel('Key tick', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Key tick', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Key tick', { exact: true })).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('960000');
  await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('140');
  await expect(key).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.controlledTest.inspect().revision.sequence)).toBe(0);
});
